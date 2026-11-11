from pathlib import Path
import base64
import hashlib
import json
import os
import socket
import subprocess
import time
import urllib.request
import uuid
import zipfile
import websocket

app_root = Path(__file__).resolve().parent.parent
app_version = json.loads((app_root / 'package.json').read_text(encoding='utf-8'))['version']
check_root = app_root.parent / 'vault-build-check' / uuid.uuid4().hex[:8]
check_root.mkdir(parents=True)
data_root = check_root / 'user-data'
export_root = check_root / 'exports'
export_root.mkdir()
executable = app_root / 'release' / 'win-unpacked' / 'DocNest.exe'
assert executable.exists(), 'Build the Windows app first.'
update_config = json.loads(subprocess.check_output(['node', '-e', "console.log(JSON.stringify(require('js-yaml').load(require('fs').readFileSync(process.argv[1],'utf8'))))", str(executable.parent / 'resources' / 'app-update.yml')], cwd=app_root, text=True, creationflags=subprocess.CREATE_NO_WINDOW))
assert update_config == {'provider': 'github', 'owner': 'zeng1144318071-bot', 'repo': 'project-vault-desktop', 'updaterCacheDirName': 'project-vault-preview-updater'}
standard = json.loads((app_root / 'examples/project-vault-example.json').read_text(encoding='utf-8'))
assert (app_root / 'release/project-vault-example.json').read_bytes() == (app_root / 'examples/project-vault-example.json').read_bytes()
with zipfile.ZipFile(app_root / 'release' / f'DocNest-Examples-{app_version}.zip') as example_zip:
    assert example_zip.testzip() is None
    members = {name for name in example_zip.namelist() if not name.endswith('/')}
    assert members == {'examples/' + file['name'] for file in standard['files']} | {'examples/project-vault-example.json', 'examples/README.md'}
    assert json.loads(example_zip.read('examples/project-vault-example.json')) == standard
    for file in standard['files']:
        assert example_zip.read('examples/' + file['name']).decode('utf-8') == file['content']

def free_port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]

class CDP:
    def __init__(self, port, kind=None):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=1) as response:
                    targets = json.load(response)
                target = next(target for target in targets if (kind is None or target.get('type') == kind))
                self.connection = websocket.create_connection(target['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)
                self.counter = 0
                return
            except (OSError, StopIteration, ValueError, websocket.WebSocketException):
                time.sleep(.15)
        raise RuntimeError('The packaged application did not expose its test target.')
    def call(self, method, params=None):
        self.counter += 1
        self.connection.send(json.dumps({'id': self.counter, 'method': method, 'params': params or {}}))
        while True:
            result = json.loads(self.connection.recv())
            if result.get('id') == self.counter:
                if 'error' in result:
                    raise RuntimeError(str(result['error']))
                return result.get('result', {})
    def evaluate(self, expression):
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'].get('exception', {}).get('description', 'JavaScript evaluation failed'))
        return result.get('result', {}).get('value')
    def wait(self, condition, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.evaluate(condition):
                return
            time.sleep(.05)
        raise AssertionError('Timed out: ' + condition)

def start_app(label):
    renderer_port, main_port = free_port(), free_port()
    environment = os.environ.copy()
    environment.update(PROJECT_VAULT_TEST_MODE='1', PROJECT_VAULT_TEST_DATA_DIR=str(data_root))
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    log = (check_root / f'{label}.log').open('w', encoding='utf-8')
    process = subprocess.Popen([str(executable), '--disable-gpu', f'--remote-debugging-port={renderer_port}', f'--inspect={main_port}'], cwd=app_root, env=environment, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
    main = CDP(main_port)
    package = json.dumps(str(app_root / 'package.json'))
    main.evaluate(f"globalThis.__pvElectron = process.getBuiltinModule('module').createRequire({package})('electron'); true")
    renderer = CDP(renderer_port, 'page')
    renderer.wait("document.body?.dataset.appReady === 'true'", 25)
    # Hosted Windows runners may disable animations at OS level. Exercise the
    # normal and reduced-motion paths explicitly rather than inheriting the OS.
    renderer.call('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'no-preference'}]})
    main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false); true")
    return process, main, renderer, log

def stop_app(process, main, renderer, log):
    try:
        main.evaluate("setTimeout(() => globalThis.__pvElectron.app.quit(), 100); true")
        renderer.connection.close()
        main.connection.close()
        process.wait(timeout=12)
    finally:
        renderer.connection.close()
        main.connection.close()
        log.close()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)

def click(renderer, identifier):
    renderer.evaluate(f"(() => {{ const control = document.getElementById({json.dumps(identifier)}); control.focus(); control.click(); return true; }})()")

def set_value(renderer, identifier, value, event='change'):
    renderer.evaluate(f"(() => {{ const node = document.getElementById({json.dumps(identifier)}); node.value = {json.dumps(value)}; node.dispatchEvent(new Event({json.dumps(event)}, {{bubbles:true}})); return true; }})()")

def press_key(renderer, key, code, virtual_key, modifiers=0):
    for event_type in ['keyDown', 'keyUp']:
        event = {'type': event_type, 'key': key, 'code': code, 'windowsVirtualKeyCode': virtual_key, 'modifiers': modifiers}
        # Chromium activates native buttons on Enter's character event.
        if event_type == 'keyDown' and key == 'Enter':
            event['text'] = '\r'
        renderer.call('Input.dispatchKeyEvent', event)

def press_native_key(main, key, modifiers=None):
    # CDP dispatches renderer events directly and bypasses Electron's before-input-event.
    for event_type in ['keyDown', 'keyUp']:
        event = {'type': event_type, 'keyCode': key, 'modifiers': modifiers or []}
        main.evaluate('globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.sendInputEvent(' + json.dumps(event) + '); true')

def hover(renderer, identifier):
    point = renderer.evaluate(f"(() => {{ const rect=document.getElementById({json.dumps(identifier)}).getBoundingClientRect(); return {{x:rect.left+rect.width/2,y:rect.top+rect.height/2}}; }})()")
    renderer.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', **point})

def select_record(renderer, identifier):
    renderer.evaluate(f"(() => {{ const button=[...document.querySelectorAll('[data-record]')].find(node => node.dataset.record === {json.dumps(identifier)}); button.focus(); button.click(); }})()")

def double_click_record(renderer, identifier):
    point = renderer.evaluate(f"(() => {{ const rect=[...document.querySelectorAll('[data-record]')].find(node => node.dataset.record === {json.dumps(identifier)}).querySelector('.pv-file-name').getBoundingClientRect(); return {{x:rect.left+Math.min(rect.width/2,40),y:rect.top+rect.height/2}}; }})()")
    for count in [1, 2]:
        renderer.call('Input.dispatchMouseEvent', {'type': 'mousePressed', 'button': 'left', 'clickCount': count, **point})
        renderer.call('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'button': 'left', 'clickCount': count, **point})

def answer_delete(renderer, confirmed):
    renderer.wait("document.getElementById('pv-confirm-dialog').open")
    click(renderer, 'pv-confirm-delete' if confirmed else 'pv-confirm-cancel')
    renderer.wait("!document.getElementById('pv-confirm-dialog').open")

def capture(main, name):
    main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')")
    for attempt in range(3):
        main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.invalidate(); true")
        main.evaluate('new Promise(resolve => setTimeout(() => resolve(true), 250))')
        try:
            # Hidden windows can return an older compositor frame on the first read.
            for _ in range(3):
                screenshot = main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {stayHidden:true, stayAwake:true}).then(image => image.toPNG().toString('base64'))")
            break
        except RuntimeError:
            if attempt == 2:
                raise
    (check_root / name).write_bytes(base64.b64decode(screenshot))

process, main, renderer, log = start_app('initial')
try:
    assert main.evaluate("globalThis.__pvElectron.app.getVersion()") == app_version
    assert main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].getTitle()") == 'DocNest'
    assert renderer.evaluate("document.getElementById('pv-project').options.length") == 1
    assert renderer.evaluate("document.getElementById('pv-project').selectedOptions[0].textContent") == '标准示例项目'
    click(renderer, 'pv-project-example')
    assert renderer.evaluate("document.querySelectorAll('#pv-content .pv-overview-item').length") == 4
    assert renderer.evaluate('window.vaultApp.load()')['store'] is None
    select_record(renderer, 'guide')
    if not renderer.evaluate("document.getElementById('pv-toast').hidden"):
        click(renderer, 'pv-toast-close')
    renderer.wait("document.getElementById('pv-toast').hidden")
    # Observe external navigation through the real IPC handler without launching a browser.
    main.evaluate("globalThis.__pvExternalUrls = []; globalThis.__pvElectron.shell.openExternal = async url => {globalThis.__pvExternalUrls.push(url);}; true")
    repository_url = json.loads((app_root / 'package.json').read_text(encoding='utf-8'))['repository']['url'].removesuffix('.git')
    assert renderer.evaluate("document.getElementById('pv-github').dataset.tooltip") == 'GitHub 仓库 · ' + repository_url
    hover(renderer, 'pv-github')
    renderer.wait("document.getElementById('pv-action-tooltip').matches(':popover-open')")
    assert renderer.evaluate("document.getElementById('pv-action-tooltip').textContent") == 'GitHub 仓库 · ' + repository_url
    assert renderer.evaluate("(() => { const rect=document.getElementById('pv-action-tooltip').getBoundingClientRect(); return rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight; })()")
    capture(main, 'github-repository-link.png')
    click(renderer, 'pv-github')
    main.wait("globalThis.__pvExternalUrls.length === 1")
    assert main.evaluate('globalThis.__pvExternalUrls') == [repository_url]
    # Tab from the data-folder button reaches the repository button and shows its tooltip.
    renderer.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': 2, 'y': 2})
    renderer.evaluate("document.getElementById('pv-data-directory').focus(); true")
    press_key(renderer, 'Tab', 'Tab', 9)
    renderer.wait("document.activeElement.id === 'pv-github' && document.getElementById('pv-action-tooltip').matches(':popover-open')")
    press_key(renderer, 'Enter', 'Enter', 13)
    main.wait("globalThis.__pvExternalUrls.length === 2")
    assert main.evaluate('globalThis.__pvExternalUrls') == [repository_url, repository_url]
    renderer.evaluate("document.activeElement.blur(); true")
    # Update UI uses synthetic states and a mocked installer. Test mode has no network.
    assert renderer.evaluate('window.vaultApp.updateState()')['status'] == 'disabled'
    capture(main, 'readme-overview.png')
    select_record(renderer, 'environment')
    assert renderer.evaluate("Array.from(document.querySelectorAll('#pv-content .pv-env-group')).map(node => node.dataset.envSection)") == ['', 'app', 'database', 'redis', 'storage']
    capture(main, 'readme-env.png')
    select_record(renderer, 'guide')
    main.evaluate("""(() => {
      const ipc = globalThis.__pvElectron.ipcMain;
      globalThis.__pvUpdate = { status:'up-to-date', currentVersion:globalThis.__pvElectron.app.getVersion(), latestVersion:null, percent:0, checkedAt:1, revision:1000, message:'' };
      globalThis.__pvInstallCalls = 0;
      ipc.removeHandler('update:check');
      ipc.handle('update:check', () => ({ ...globalThis.__pvUpdate, revision: ++globalThis.__pvUpdate.revision }));
      ipc.removeHandler('update:install');
      ipc.handle('update:install', () => { globalThis.__pvInstallCalls++; return { ...globalThis.__pvUpdate, status:'installing', revision: ++globalThis.__pvUpdate.revision }; });
      globalThis.__pvSendUpdate = patch => {
        Object.assign(globalThis.__pvUpdate, patch); globalThis.__pvUpdate.revision++;
        globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.send('update:state', { ...globalThis.__pvUpdate });
      }; return true;
    })()""")
    click(renderer, 'pv-check-update')
    renderer.wait("document.getElementById('pv-toast-title').textContent === '已是最新版本'")
    main.evaluate("globalThis.__pvSendUpdate({status:'downloading', latestVersion:'1.1.0', percent:42}); true")
    renderer.wait("!document.getElementById('pv-update-card').hidden && document.getElementById('pv-update-progress').value === 42")
    click(renderer, 'pv-update-dismiss')
    assert renderer.evaluate("document.getElementById('pv-update-card').hidden")
    main.evaluate("globalThis.__pvSendUpdate({status:'downloading', percent:75}); true")
    assert renderer.evaluate("document.getElementById('pv-update-card').hidden")
    main.evaluate("globalThis.__pvSendUpdate({status:'downloaded', percent:100}); true")
    renderer.wait("!document.getElementById('pv-update-card').hidden && !document.getElementById('pv-update-install').hidden")
    click(renderer, 'pv-toast-close')
    renderer.evaluate("document.activeElement.blur(); true")
    capture(main, 'readme-update.png')
    click(renderer, 'pv-update-install')
    renderer.wait("document.getElementById('pv-update-dialog').open")
    assert renderer.evaluate("document.activeElement.id") == 'pv-update-cancel'
    capture(main, 'update-confirmation.png')
    click(renderer, 'pv-update-cancel')
    assert main.evaluate('globalThis.__pvInstallCalls') == 0
    click(renderer, 'pv-import-open')
    set_value(renderer, 'pv-import-editor', 'Unsaved update test draft', 'input')
    click(renderer, 'pv-update-install')
    renderer.wait("document.getElementById('pv-toast-title').textContent === '暂时无法安装'")
    assert not renderer.evaluate("document.getElementById('pv-update-dialog').open")
    assert renderer.evaluate("document.getElementById('pv-import-editor').value") == 'Unsaved update test draft'
    assert main.evaluate('globalThis.__pvInstallCalls') == 0
    click(renderer, 'pv-import-back')
    click(renderer, 'pv-update-dismiss')
    click(renderer, 'pv-check-update')
    renderer.wait("document.getElementById('pv-update-dialog').open")
    press_key(renderer, 'Escape', 'Escape', 27)
    renderer.wait("!document.getElementById('pv-update-dialog').open")
    click(renderer, 'pv-update-install')
    click(renderer, 'pv-update-confirm')
    renderer.wait("document.getElementById('pv-update-card').dataset.status === 'installing'")
    assert main.evaluate('globalThis.__pvInstallCalls') == 1
    main.evaluate("globalThis.__pvSendUpdate({status:'error', message:'模拟安装失败'}); true")
    renderer.wait("!document.getElementById('pv-update-dialog').open && !document.getElementById('pv-check-update').disabled")
    main.evaluate("globalThis.__pvSendUpdate({status:'disabled', latestVersion:null, message:''}); true")
    click(renderer, 'pv-toast-close')
    assert main.evaluate("globalThis.__pvElectron.Menu.getApplicationMenu() === null && !globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].isMenuBarVisible()")
    press_native_key(main, 'Alt', ['alt'])
    assert not main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].isMenuBarVisible()")
    press_native_key(main, 'O', ['control'])
    renderer.wait("!document.getElementById('pv-import-pane').hidden")
    set_value(renderer, 'pv-import-editor', 'Shortcut editing check', 'input')
    renderer.evaluate("document.getElementById('pv-import-editor').focus(); true")
    press_key(renderer, 'a', 'KeyA', 65, 2)
    assert renderer.evaluate("(() => { const node=document.getElementById('pv-import-editor'); return node.selectionStart===0 && node.selectionEnd===node.value.length; })()")
    click(renderer, 'pv-import-back')
    press_native_key(main, 'S', ['control', 'shift'])
    renderer.wait("!document.getElementById('pv-export-pane').hidden")
    click(renderer, 'pv-export-back')
    press_native_key(main, '+', ['control', 'shift'])
    assert main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.getZoomLevel()") > 0
    press_native_key(main, '0', ['control'])
    assert main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.getZoomLevel()") == 0
    press_native_key(main, '-', ['control'])
    assert main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.getZoomLevel()") < 0
    press_native_key(main, '0', ['control'])
    assert main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.getZoomLevel()") == 0
    renderer.evaluate("document.activeElement.blur(); true")
    assert renderer.evaluate("document.getElementById('pv-save-status').textContent") == 'Windows 账户加密'
    assert renderer.evaluate("typeof require === 'undefined' && typeof process === 'undefined'")
    assert renderer.evaluate("document.querySelectorAll('#pv-content .pv-code-block').length") == 3
    assert main.evaluate("globalThis.__pvElectron.safeStorage.isEncryptionAvailable()")
    assert renderer.evaluate("document.querySelectorAll('#pv-files svg').length") == 4
    assert renderer.evaluate("Array.from(document.querySelectorAll('select.pv-input')).every(select => select.hidden)")
    # Create a second project as a test fixture; first-run data contains one standard example.
    click(renderer, 'pv-project-new')
    set_value(renderer, 'pv-project-name', '商城 · 测试', 'input')
    click(renderer, 'pv-project-create-save')
    renderer.wait("document.getElementById('pv-project').selectedOptions[0].textContent === '商城 · 测试'")
    selector_test_project = renderer.evaluate("document.getElementById('pv-project').value")
    set_value(renderer, 'pv-project', 'example')
    # Use the visible custom selector, including filtering, keyboard navigation and dismissal.
    click(renderer, 'pv-project-trigger')
    renderer.wait("document.getElementById('pv-project-popup').matches(':popover-open')")
    assert renderer.evaluate("document.querySelectorAll('#pv-project-listbox [role=option]').length") == 2
    assert renderer.evaluate("document.querySelector('#pv-project-listbox [aria-selected=true]').dataset.value") == 'example'
    capture(main, 'custom-project-selector.png')
    main.evaluate("globalThis.__pvPreviousTheme = globalThis.__pvElectron.nativeTheme.themeSource; globalThis.__pvElectron.nativeTheme.themeSource = 'dark'; true")
    capture(main, 'custom-project-selector-dark.png')
    main.evaluate("globalThis.__pvElectron.nativeTheme.themeSource = globalThis.__pvPreviousTheme; true")
    renderer.evaluate("(() => { const search = document.querySelector('#pv-project-popup input'); search.value = '商城'; search.dispatchEvent(new Event('input', {bubbles:true})); return true; })()")
    assert renderer.evaluate("document.querySelectorAll('#pv-project-listbox [role=option]').length") == 1
    press_key(renderer, 'ArrowDown', 'ArrowDown', 40)
    press_key(renderer, 'Enter', 'Enter', 13)
    renderer.wait("document.getElementById('pv-project').value === " + json.dumps(selector_test_project))
    assert not renderer.evaluate("document.getElementById('pv-project-popup').matches(':popover-open')")
    assert renderer.evaluate("document.activeElement.id") == 'pv-project-trigger'
    click(renderer, 'pv-project-trigger')
    press_key(renderer, 'Escape', 'Escape', 27)
    renderer.wait("!document.getElementById('pv-project-popup').matches(':popover-open')")
    click(renderer, 'pv-project-trigger')
    press_key(renderer, 'Tab', 'Tab', 9)
    assert renderer.evaluate("document.activeElement.id") == 'pv-search'
    assert not renderer.evaluate("document.getElementById('pv-project-popup').matches(':popover-open')")
    set_value(renderer, 'pv-project', 'example')

    # Actions display icons with accessible names and custom hover/keyboard hints.
    assert renderer.evaluate("document.getElementById('pv-status-summary').textContent.includes('TXT / ENV / JSON / MD')")
    assert renderer.evaluate("Array.from(document.querySelectorAll('.pv-action-button')).filter(button => button.getClientRects().length).every(button => button.querySelectorAll(':scope > svg').length === 1 && button.getAttribute('aria-label') && button.dataset.tooltip && !button.title && button.querySelector('.pv-sr-only') && getComputedStyle(button.querySelector('.pv-sr-only')).clipPath === 'inset(50%)' && button.getBoundingClientRect().width >= 28)")
    hover(renderer, 'pv-copy')
    renderer.wait("document.getElementById('pv-action-tooltip').matches(':popover-open')")
    assert renderer.evaluate("document.getElementById('pv-action-tooltip').textContent") == '复制内容'
    assert renderer.evaluate("document.getElementById('pv-copy').getAttribute('aria-describedby')") == 'pv-action-tooltip'
    assert renderer.evaluate("(() => { const rect=document.getElementById('pv-action-tooltip').getBoundingClientRect(); return rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight; })()")
    capture(main, 'icon-action-tooltip.png')
    renderer.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': 2, 'y': 2})
    renderer.wait("!document.getElementById('pv-action-tooltip').matches(':popover-open')")
    assert not renderer.evaluate("document.getElementById('pv-copy').hasAttribute('aria-describedby')")
    renderer.evaluate("document.getElementById('pv-reveal').focus(); true")
    press_key(renderer, 'Tab', 'Tab', 9)
    renderer.wait("document.activeElement.id === 'pv-copy' && document.getElementById('pv-action-tooltip').matches(':popover-open')")
    press_key(renderer, 'Escape', 'Escape', 27)
    assert not renderer.evaluate("document.getElementById('pv-action-tooltip').matches(':popover-open')")
    click(renderer, 'pv-reveal')
    assert renderer.evaluate("document.getElementById('pv-reveal').getAttribute('aria-label')") == '隐藏敏感值'
    assert renderer.evaluate("document.getElementById('pv-reveal').dataset.actionIcon") == 'eye-off'
    click(renderer, 'pv-reveal')
    assert renderer.evaluate("document.getElementById('pv-reveal').getAttribute('aria-label')") == '显示敏感值'
    assert renderer.evaluate("document.getElementById('pv-reveal').dataset.actionIcon") == 'eye'

    # Clipboard writes are intercepted in the renderer, preserving the user's clipboard.
    renderer.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async value => {window.__pvCopiedValue = value;}}}); true")
    copy_width = renderer.evaluate("document.getElementById('pv-copy').getBoundingClientRect().width")
    toast_started = time.monotonic()
    click(renderer, 'pv-copy')
    renderer.wait("!document.getElementById('pv-toast').hidden && document.getElementById('pv-toast-title').textContent === '复制成功'")
    assert renderer.evaluate("window.__pvCopiedValue.includes('# 运行与配置说明')")
    assert renderer.evaluate("document.getElementById('pv-copy').dataset.copied") == 'true'
    assert renderer.evaluate("document.getElementById('pv-copy').getBoundingClientRect().width") == copy_width
    assert renderer.evaluate("document.getElementById('pv-copy').getAttribute('aria-label')") == '已复制'
    assert renderer.evaluate("document.querySelector('#pv-copy .pv-sr-only').textContent") == '已复制'
    assert renderer.evaluate("document.getElementById('pv-toast-countdown').textContent") == '3'
    renderer.wait("document.getElementById('pv-toast-countdown').textContent === '2'", 2)
    hover(renderer, 'pv-toast-close')
    renderer.wait("document.getElementById('pv-toast-countdown').textContent === '1'", 2)
    assert not renderer.evaluate("document.getElementById('pv-toast').hidden")
    renderer.wait("document.getElementById('pv-toast').dataset.state === 'leaving'", 2)
    assert not renderer.evaluate("document.getElementById('pv-toast').hidden")
    # Hidden windows suspend compositor frames; seek the fade to verify its visual midpoint.
    exit_opacity = renderer.evaluate("(() => { const toast=document.getElementById('pv-toast'), animation=toast.getAnimations().find(item=>item.playState==='running'); animation.pause(); animation.currentTime=100; return Number(getComputedStyle(toast).opacity); })()")
    assert 0 < exit_opacity < 1
    renderer.wait("document.getElementById('pv-toast').hidden", 2)
    assert 2.8 <= time.monotonic() - toast_started <= 3.8
    assert not renderer.evaluate("document.getElementById('pv-action-tooltip').matches(':popover-open')")
    # Repeated copying restarts the countdown and cancels the previous dismissal.
    click(renderer, 'pv-copy')
    renderer.wait("document.getElementById('pv-toast-countdown').textContent === '2'", 2)
    click(renderer, 'pv-copy')
    assert renderer.evaluate("document.getElementById('pv-toast-countdown').textContent") == '3'
    renderer.wait("document.getElementById('pv-copy').dataset.copied === 'true'")
    renderer.wait("!document.getElementById('pv-copy').dataset.copied", 5)
    assert renderer.evaluate("document.getElementById('pv-copy').textContent.includes('复制内容')")
    assert renderer.evaluate("document.getElementById('pv-copy').getAttribute('aria-label')") == '复制内容'
    assert renderer.evaluate("document.getElementById('pv-copy').dataset.tooltip") == '复制内容'
    assert renderer.evaluate("document.getElementById('pv-copy').getBoundingClientRect().width") == copy_width
    renderer.wait("document.getElementById('pv-toast-countdown').textContent === '1'", 2)
    assert not renderer.evaluate("document.getElementById('pv-toast').hidden")
    renderer.wait("document.getElementById('pv-toast').hidden", 2)
    renderer.call('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'reduce'}]})
    click(renderer, 'pv-copy')
    assert renderer.evaluate("document.getElementById('pv-toast-countdown').textContent") == '3'
    assert renderer.evaluate("document.getElementById('pv-toast-progress').getAnimations().length") == 0
    renderer.wait("document.getElementById('pv-toast-countdown').textContent === '2'", 2)
    assert renderer.evaluate("parseFloat(getComputedStyle(document.getElementById('pv-toast-progress')).strokeDashoffset)") > .3
    click(renderer, 'pv-toast-close')
    assert renderer.evaluate("document.getElementById('pv-toast').hidden")
    assert renderer.evaluate("document.activeElement.id") == 'pv-copy'
    renderer.call('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'no-preference'}]})
    # A replacement toast must survive the completion of the previous exit animation.
    click(renderer, 'pv-copy')
    click(renderer, 'pv-toast-close')
    renderer.wait("document.getElementById('pv-toast').dataset.state === 'leaving'")
    click(renderer, 'pv-copy')
    renderer.evaluate("new Promise(resolve => setTimeout(() => resolve(true), 300))")
    assert renderer.evaluate("!document.getElementById('pv-toast').hidden && !document.getElementById('pv-toast').dataset.state && document.getElementById('pv-toast-countdown').textContent === '3'")
    click(renderer, 'pv-copy')
    capture(main, 'copy-success-toast.png')
    click(renderer, 'pv-toast-close')
    renderer.evaluate("navigator.clipboard.writeText = async () => {throw new Error('test clipboard failure');}; true")
    click(renderer, 'pv-copy')
    renderer.wait("document.getElementById('pv-toast-title').textContent === '复制失败'")
    assert renderer.evaluate("document.getElementById('pv-toast').dataset.tone") == 'error'
    assert renderer.evaluate("!document.getElementById('pv-copy').dataset.copied")
    click(renderer, 'pv-toast-close')
    renderer.evaluate("navigator.clipboard.writeText = async value => {window.__pvCopiedValue = value;}; true")
    renderer.evaluate("document.querySelector('#pv-content .pv-code-copy').click(); true")
    renderer.wait("document.getElementById('pv-toast-title').textContent === '复制成功' && !document.getElementById('pv-toast').hidden")
    assert renderer.evaluate("window.__pvCopiedValue") == 'npm ci\nnpm run dev'
    click(renderer, 'pv-toast-close')
    for record_id, format_name in [('accounts', 'TXT'), ('environment', 'ENV'), ('settings', 'JSON'), ('guide', 'MD')]:
        renderer.evaluate(f"document.querySelector('[data-record={record_id}]').click(); true")
        assert renderer.evaluate("document.getElementById('pv-native-type').textContent") == format_name
        if record_id == 'settings':
            capture(main, 'icon-json-library.png')
    click(renderer, 'pv-overview')
    assert renderer.evaluate("document.querySelectorAll('#pv-content .pv-overview-item').length") == 4
    click(renderer, 'pv-export-open')
    click(renderer, 'pv-export-format-trigger')
    renderer.wait("document.getElementById('pv-export-format-popup').matches(':popover-open')")
    renderer.evaluate("document.querySelector('#pv-export-format-listbox [data-value=json]').click(); true")
    assert renderer.evaluate("document.getElementById('pv-export-format').value") == 'json'
    click(renderer, 'pv-export-copy')
    renderer.wait("document.getElementById('pv-export-copy').dataset.copied === 'true'")
    assert len(json.loads(renderer.evaluate('window.__pvCopiedValue'))['files']) == 4
    click(renderer, 'pv-toast-close')
    for format_name, extension in [('text', 'txt'), ('env', 'env'), ('json', 'json'), ('markdown', 'md')]:
        target = export_root / f'project.{extension}'
        main.evaluate("globalThis.__pvElectron.dialog.showSaveDialog = async () => ({ canceled:false, filePath:" + json.dumps(str(target)) + ' }); true')
        set_value(renderer, 'pv-export-format', format_name)
        click(renderer, 'pv-export-save')
        deadline = time.monotonic() + 5
        while (not target.exists() or target.stat().st_size <= 100) and time.monotonic() < deadline:
            time.sleep(.05)
        assert target.exists() and target.stat().st_size > 100, format_name + ': ' + str(renderer.evaluate("document.getElementById('pv-feedback').textContent"))
    bundle = json.loads((export_root / 'project.json').read_text(encoding='utf-8'))
    assert len(bundle['files']) == 4 and len({item['format'] for item in bundle['files']}) == 4
    click(renderer, 'pv-export-back')
    click(renderer, 'pv-project-new')
    set_value(renderer, 'pv-project-name', '安装包验证项目', 'input')
    click(renderer, 'pv-project-create-save')
    renderer.wait("document.getElementById('pv-project').selectedOptions[0].textContent === '安装包验证项目'")
    contents = {
        'text': ('notes.txt', '第一行\n第二行：本地文本验证\n  保留缩进'),
        'env': ('.env.test', ('# shared configuration\nGLOBAL=on\n\n [ app ] ; runtime\nAPP_ENV=testing\nCACHE_PREFIX=${APP_ENV}_demo\nLIST=[one,two]\nMESSAGE="first line\n[not_a_section]\nlast line"\nEMPTY_VALUE=\n\n[database] # storage\nHOST=db.example.test\nDB_PASSWORD="TEST_ONLY_PRIVATE_MARKER_72641"\nACCESS_TOKEN="first_private_marker\n[private_marker]\nlast_private_marker"\n\n[app]\nRETRY=3\n[empty]\n').replace('\n', '\r\n')),
        'json': ('config.json', '{"enabled":true,"nested":{"port":3306},"list":[1,2],"empty":null}'),
        'markdown': ('guide.md', '# 标题\n\n- **加粗**\n\n| 键 | 值 |\n| --- | --- |\n| A | B |\n\n```bash\necho demo\n```\n\n<img src=x onerror=alert(1)>')
    }
    # Paste recognition replaces the removed name/type form; preview remains editable.
    click(renderer, 'pv-import-open')
    assert renderer.evaluate("document.querySelector('#pv-import-pane .pv-form-row') === null && document.getElementById('pv-import-name') === null && document.getElementById('pv-import-format') === null")
    for format_name, (_, content) in contents.items():
        set_value(renderer, 'pv-import-editor', content, 'input')
        assert renderer.evaluate("document.getElementById('pv-import-preview-type').dataset.format") == format_name
        assert not renderer.evaluate("document.getElementById('pv-import-add').disabled")
    set_value(renderer, 'pv-import-editor', '[reference](https://example.test)', 'input')
    assert renderer.evaluate("document.getElementById('pv-import-preview-type').dataset.format") == 'markdown'
    set_value(renderer, 'pv-import-editor', '{"broken":', 'input')
    assert renderer.evaluate("document.getElementById('pv-import-preview-type').dataset.format") == 'json'
    assert renderer.evaluate("document.getElementById('pv-import-add').disabled && !document.getElementById('pv-import-error').hidden")
    set_value(renderer, 'pv-import-editor', 'KEY=value\nEMPTY=', 'input')
    assert renderer.evaluate("document.getElementById('pv-import-preview-type').dataset.format") == 'env'
    assert renderer.evaluate("document.querySelectorAll('#pv-import-preview .pv-env-group').length") == 0
    set_value(renderer, 'pv-import-editor', '', 'input')
    assert renderer.evaluate("document.getElementById('pv-import-add').disabled")
    click(renderer, 'pv-import-back')
    for format_name, (name, content) in contents.items():
        native_input = check_root / name
        native_input.write_text(content, encoding='utf-8', newline='')
        main.evaluate("globalThis.__pvElectron.dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[" + json.dumps(str(native_input)) + '] }); true')
        click(renderer, 'pv-import-open')
        click(renderer, 'pv-choose-file')
        renderer.wait('document.getElementById("pv-import-editor").value === ' + json.dumps(content.replace('\r\n', '\n')))
        assert renderer.evaluate("document.getElementById('pv-import-preview-type').dataset.format") == format_name
        assert renderer.evaluate("document.getElementById('pv-chosen-file').textContent") == name
        if format_name == 'env':
            assert renderer.evaluate("Array.from(document.querySelectorAll('#pv-import-preview .pv-env-group')).map(node => node.dataset.envSection)") == ['', 'app', 'database', 'app', 'empty']
            assert renderer.evaluate("(() => { const all=document.querySelector('#pv-import-preview .pv-env-all').getBoundingClientRect(), groups=document.querySelector('#pv-import-preview .pv-env-groups').getBoundingClientRect(); return Math.abs(all.left-groups.left)<1 && groups.top>all.bottom; })()")
            assert renderer.evaluate("document.querySelector('#pv-import-preview [data-env-section=database] .pv-code-body code').textContent.startsWith('[database] # storage')")
            assert renderer.evaluate("document.querySelector('#pv-import-preview [data-env-section=database] .pv-code-language').textContent") == 'INI'
            assert renderer.evaluate("Array.from(document.querySelectorAll('#pv-import-preview [data-env-section=database] .pv-token-setting')).map(node=>node.textContent)") == ['[database]', 'HOST', 'DB_PASSWORD', 'ACCESS_TOKEN']
            preview = renderer.evaluate("document.getElementById('pv-import-preview').textContent")
            assert '全局配置' in preview and '[not_a_section]' in preview and 'LIST=[one,two]' in preview
            assert not any(marker in preview for marker in ['TEST_ONLY_PRIVATE_MARKER_72641', 'first_private_marker', '[private_marker]', 'last_private_marker'])
            capture(main, 'env-grouped-import.png')
            main.evaluate("globalThis.__pvElectron.nativeTheme.themeSource = 'dark'; true")
            capture(main, 'env-grouped-import-dark.png')
            main.evaluate("globalThis.__pvElectron.nativeTheme.themeSource = globalThis.__pvPreviousTheme; true")
        if format_name == 'markdown':
            assert renderer.evaluate("document.querySelectorAll('#pv-import-preview table').length") == 1
            assert renderer.evaluate("document.querySelectorAll('#pv-import-preview img').length") == 0
        click(renderer, 'pv-import-add')
        renderer.wait("!document.getElementById('pv-library').hidden && document.getElementById('pv-save-status').textContent === '已加密保存'")
        assert renderer.evaluate("document.getElementById('pv-title').textContent") == name
        if format_name == 'env':
            assert renderer.evaluate("document.querySelectorAll('#pv-content .pv-env-group').length") == 5
            assert renderer.evaluate("(() => { const all=document.querySelector('#pv-content .pv-env-all').getBoundingClientRect(), groups=document.querySelector('#pv-content .pv-env-groups').getBoundingClientRect(); return groups.left>all.right && Math.abs(all.top-groups.top)<1; })()")
            renderer.evaluate("document.querySelector('#pv-content .pv-env-all .pv-code-copy').click(); true")
            renderer.wait("window.__pvCopiedValue.startsWith('# shared configuration')")
            assert '[database] # storage' in renderer.evaluate('window.__pvCopiedValue')
            assert '[empty]' in renderer.evaluate('window.__pvCopiedValue')
            assert not any(marker in renderer.evaluate('window.__pvCopiedValue') for marker in ['TEST_ONLY_PRIVATE_MARKER_72641', 'first_private_marker', '[private_marker]', 'last_private_marker'])
            click(renderer, 'pv-toast-close')
            renderer.wait("document.getElementById('pv-toast').hidden")
            capture(main, 'env-columns-light.png')
            main.evaluate("globalThis.__pvElectron.nativeTheme.themeSource = 'dark'; true")
            capture(main, 'env-columns-dark.png')
            main.evaluate("globalThis.__pvElectron.nativeTheme.themeSource = globalThis.__pvPreviousTheme; globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].setSize(800,900); true")
            renderer.wait("(() => { const all=document.querySelector('#pv-content .pv-env-all').getBoundingClientRect(), groups=document.querySelector('#pv-content .pv-env-groups').getBoundingClientRect(); return Math.abs(all.left-groups.left)<1 && groups.top>all.bottom; })()")
            assert renderer.evaluate("document.querySelector('.pv-main').scrollWidth <= document.querySelector('.pv-main').clientWidth")
            capture(main, 'env-columns-narrow.png')
            main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].setSize(1220,900); true")
            renderer.evaluate("document.querySelector('#pv-content [data-env-section=database] .pv-code-copy').click(); true")
            renderer.wait("window.__pvCopiedValue.startsWith('[database] # storage')")
            assert 'HOST=db.example.test' in renderer.evaluate('window.__pvCopiedValue')
            assert 'TEST_ONLY_PRIVATE_MARKER_72641' not in renderer.evaluate('window.__pvCopiedValue')
            assert '[app]' not in renderer.evaluate('window.__pvCopiedValue')
            click(renderer, 'pv-reveal')
            assert renderer.evaluate("document.querySelectorAll('#pv-content .pv-env-group').length") == 5
            assert '[private_marker]' in renderer.evaluate("document.querySelector('#pv-content [data-env-section=database]').textContent")
            assert renderer.evaluate("document.querySelector('#pv-content .pv-env-all .pv-code-body code').textContent") == content
            renderer.evaluate("document.querySelector('#pv-content .pv-env-all .pv-code-copy').click(); true")
            renderer.wait('window.__pvCopiedValue === ' + json.dumps(content))
            click(renderer, 'pv-copy')
            renderer.wait('window.__pvCopiedValue === ' + json.dumps(content))
            click(renderer, 'pv-toast-close')
            click(renderer, 'pv-overview')
            assert renderer.evaluate("document.querySelectorAll('#pv-content .pv-env-group').length") == 5
            # Same-format export keeps original section text and Windows line endings.
            renderer.evaluate("document.querySelector('#pv-files .pv-file[aria-pressed=false]:last-child').click(); true")
            click(renderer, 'pv-export-open')
            renderer.evaluate("(() => { const node=document.getElementById('pv-export-secrets'); node.checked=true; node.dispatchEvent(new Event('change', {bubbles:true})); })()")
            assert renderer.evaluate("document.querySelectorAll('#pv-export-preview .pv-env-group').length") == 5
            click(renderer, 'pv-export-copy')
            renderer.wait('window.__pvCopiedValue === ' + json.dumps(content))
            env_target = export_root / 'sectioned.env'
            main.evaluate("globalThis.__pvElectron.dialog.showSaveDialog = async () => ({canceled:false,filePath:" + json.dumps(str(env_target)) + '}); true')
            click(renderer, 'pv-export-save')
            deadline = time.monotonic() + 5
            while (not env_target.exists() or env_target.stat().st_size != len(content.encode('utf-8'))) and time.monotonic() < deadline:
                time.sleep(.05)
            assert env_target.read_bytes() == content.encode('utf-8')
            click(renderer, 'pv-export-back')
    store = renderer.evaluate('window.vaultApp.load()')['store']
    project_id = next(key for key, value in store['projects'].items() if value == '安装包验证项目')
    imported = [record for record in store['records'] if record['project'] == project_id]
    assert len(imported) == 4
    for format_name, (name, content) in contents.items():
        assert next(record['source'] for record in imported if record['format'] == format_name) == content

    # Renaming edits metadata only; cancellation and failed saves leave stored bytes intact.
    json_record = next(record for record in imported if record['format'] == 'json')
    select_record(renderer, json_record['id'])
    original_bytes = (data_root / 'vault.dat').read_bytes()
    original_store = renderer.evaluate('window.vaultApp.load()')['store']
    click(renderer, 'pv-rename')
    renderer.wait("document.getElementById('pv-rename-dialog').open")
    assert renderer.evaluate("document.activeElement.id") == 'pv-rename-input'
    assert renderer.evaluate("document.getElementById('pv-rename-input').selectionEnd") == len('config')
    capture(main, 'rename-dialog.png')
    set_value(renderer, 'pv-rename-input', '取消的修改', 'input')
    for _ in range(6):
        press_key(renderer, 'Tab', 'Tab', 9)
        assert renderer.evaluate("Boolean(document.activeElement.closest('#pv-rename-dialog'))")
    press_key(renderer, 'Escape', 'Escape', 27)
    renderer.wait("!document.getElementById('pv-rename-dialog').open")
    assert renderer.evaluate("document.activeElement.id") == 'pv-rename'
    assert (data_root / 'vault.dat').read_bytes() == original_bytes
    press_key(renderer, 'F2', 'F2', 113)
    renderer.wait("document.getElementById('pv-rename-dialog').open")
    for invalid in ['', '   ', 'bad?.json', 'notes.txt', 'CON.json', 'long' * 64]:
        set_value(renderer, 'pv-rename-input', invalid, 'input')
        assert renderer.evaluate("document.getElementById('pv-rename-save').disabled && !document.getElementById('pv-rename-error').hidden")
    click(renderer, 'pv-rename-cancel')
    renderer.wait("!document.getElementById('pv-rename-dialog').open")
    assert (data_root / 'vault.dat').read_bytes() == original_bytes
    click(renderer, 'pv-rename')
    click(renderer, 'pv-rename-save')
    renderer.wait("!document.getElementById('pv-rename-dialog').open")
    assert (data_root / 'vault.dat').read_bytes() == original_bytes

    click(renderer, 'pv-rename')
    set_value(renderer, 'pv-rename-input', '应用连接', 'input')
    main.evaluate("globalThis.__pvFs = process.getBuiltinModule('fs/promises'); globalThis.__pvOriginalRename = globalThis.__pvFs.rename; globalThis.__pvFs.rename = async () => { globalThis.__pvFs.rename = globalThis.__pvOriginalRename; throw new Error('测试重命名保存失败'); }; true")
    click(renderer, 'pv-rename-save')
    renderer.wait("document.getElementById('pv-rename-dialog').open && document.getElementById('pv-rename-error').textContent.includes('名称保存失败') && !document.getElementById('pv-rename-save').disabled")
    assert renderer.evaluate('window.vaultApp.load()')['store'] == original_store
    assert (data_root / 'vault.dat').read_bytes() == original_bytes
    renderer.evaluate("document.getElementById('pv-rename-input').focus(); true")
    press_key(renderer, 'Enter', 'Enter', 13)
    renderer.wait("!document.getElementById('pv-rename-dialog').open && document.getElementById('pv-title').textContent === '应用连接.json'")
    assert renderer.evaluate("document.getElementById('pv-breadcrumb-file').textContent") == '应用连接.json'
    assert renderer.evaluate("document.querySelector('#pv-files [aria-pressed=true] .pv-file-name').textContent") == '应用连接.json'
    renamed_json = next(record for record in renderer.evaluate('window.vaultApp.load()')['store']['records'] if record['id'] == json_record['id'])
    assert renamed_json == {**json_record, 'name': '应用连接.json'}
    click(renderer, 'pv-export-open')
    assert renderer.evaluate("document.getElementById('pv-export-filename').textContent") == '应用连接.json'
    main.evaluate("globalThis.__pvElectron.dialog.showSaveDialog = async (window, options) => {globalThis.__pvSaveDefaultPath=options.defaultPath; return {canceled:true};}; true")
    click(renderer, 'pv-export-save')
    main.wait("Boolean(globalThis.__pvSaveDefaultPath)")
    assert main.evaluate("process.getBuiltinModule('path').basename(globalThis.__pvSaveDefaultPath)") == '应用连接.json'
    click(renderer, 'pv-export-back')

    env_initial = next(record for record in imported if record['format'] == 'env')
    double_click_record(renderer, env_initial['id'])
    renderer.wait("document.getElementById('pv-rename-dialog').open")
    assert renderer.evaluate("document.getElementById('pv-rename-input').value") == env_initial['name']
    set_value(renderer, 'pv-rename-input', '生产环境.env', 'input')
    click(renderer, 'pv-rename-save')
    renderer.wait("!document.getElementById('pv-rename-dialog').open && document.getElementById('pv-title').textContent === '生产环境.env'")
    click(renderer, 'pv-overview')
    md_initial = next(record for record in imported if record['format'] == 'markdown')
    renderer.evaluate(f"(() => {{const button=[...document.querySelectorAll('[data-rename-record]')].find(node=>node.dataset.renameRecord==={json.dumps(md_initial['id'])});button.focus();button.click();}})()")
    renderer.wait("document.getElementById('pv-rename-dialog').open")
    set_value(renderer, 'pv-rename-input', '部署说明.md', 'input')
    click(renderer, 'pv-rename-save')
    renderer.wait("!document.getElementById('pv-rename-dialog').open && document.getElementById('pv-toast-detail').textContent === '部署说明.md'")
    assert renderer.evaluate("document.getElementById('pv-title').textContent") == '项目完整预览'
    text_initial = next(record for record in imported if record['format'] == 'text')
    renderer.evaluate(f"[...document.querySelectorAll('[data-record]')].find(node=>node.dataset.record==={json.dumps(text_initial['id'])}).focus(); true")
    press_key(renderer, 'F2', 'F2', 113)
    renderer.wait("document.getElementById('pv-rename-dialog').open")
    set_value(renderer, 'pv-rename-input', '本地资料', 'input')
    click(renderer, 'pv-rename-save')
    renderer.wait("!document.getElementById('pv-rename-dialog').open && document.getElementById('pv-toast-detail').textContent === '本地资料.txt'")
    assert renderer.evaluate("document.getElementById('pv-title').textContent") == '项目完整预览'
    renamed_store = renderer.evaluate('window.vaultApp.load()')['store']
    names_by_format = {'json': '应用连接.json', 'env': '生产环境.env', 'markdown': '部署说明.md', 'text': '本地资料.txt'}
    for initial in imported:
        assert next(record for record in renamed_store['records'] if record['id'] == initial['id']) == {**initial, 'name': names_by_format[initial['format']]}
    assert renamed_store['projects'] == original_store['projects']
    assert [record for record in renamed_store['records'] if record['project'] != project_id] == [record for record in original_store['records'] if record['project'] != project_id]
    encrypted = (data_root / 'vault.dat').read_bytes()
    assert b'TEST_ONLY_PRIVATE_MARKER_72641' not in encrypted
    assert '安装包验证项目'.encode() not in encrypted
    assert not encrypted.startswith(b'{')
    assert (data_root / 'vault.prev.dat').exists()
    renderer.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    capture(main, 'installed-app.png')
finally:
    stop_app(process, main, renderer, log)

process, main, renderer, log = start_app('restart')
try:
    loaded = renderer.evaluate('window.vaultApp.load()')['store']
    assert loaded == renamed_store
    assert len([record for record in loaded['records'] if record['project'] == project_id]) == 4
    assert renderer.evaluate("document.getElementById('pv-project').selectedOptions[0].textContent") == '安装包验证项目'
    env_record = next(record for record in loaded['records'] if record['project'] == project_id and record['format'] == 'env')
    renderer.evaluate('document.querySelector(\'[data-record="' + env_record['id'] + '"]\').click(); true')
    assert 'TEST_ONLY_PRIVATE_MARKER_72641' not in renderer.evaluate("document.getElementById('pv-content').textContent")
    click(renderer, 'pv-edit')
    edited = contents['env'][1] + 'EDITED=yes\n'
    set_value(renderer, 'pv-import-editor', edited, 'input')
    click(renderer, 'pv-import-add')
    renderer.wait("!document.getElementById('pv-library').hidden && document.getElementById('pv-save-status').textContent === '已加密保存'")
    saved = renderer.evaluate('window.vaultApp.load()')['store']
    edited_record = next(record for record in saved['records'] if record['id'] == env_record['id'])
    assert edited_record['source'] == edited.replace('\r\n', '\n')
    assert edited_record['name'] == env_record['name'] and edited_record['format'] == 'env'

    # Deletion must use the styled renderer modal; any OS message box is a failure.
    before_cancel = (data_root / 'vault.dat').read_bytes()
    main.evaluate("globalThis.__pvNativeDialogCalls = 0; globalThis.__pvElectron.dialog.showMessageBox = async () => {globalThis.__pvNativeDialogCalls++; throw new Error('Native deletion dialog is forbidden');}; true")
    click(renderer, 'pv-delete')
    renderer.wait("document.getElementById('pv-confirm-dialog').open")
    assert renderer.evaluate("document.activeElement.id") == 'pv-confirm-cancel'
    assert renderer.evaluate("document.getElementById('pv-confirm-title').textContent") == '删除资料？'
    assert renderer.evaluate("document.getElementById('pv-confirm-name').textContent") == env_record['name']
    answer_delete(renderer, False)
    assert renderer.evaluate("document.activeElement.id") == 'pv-delete'
    assert (data_root / 'vault.dat').read_bytes() == before_cancel
    assert renderer.evaluate('window.vaultApp.load()')['store'] == saved

    click(renderer, 'pv-delete')
    answer_delete(renderer, True)
    renderer.wait('!document.querySelector(\'[data-record="' + env_record['id'] + '"]\')')
    after_file_delete = renderer.evaluate('window.vaultApp.load()')['store']
    assert not any(record['id'] == env_record['id'] for record in after_file_delete['records'])
    assert len([record for record in after_file_delete['records'] if record['project'] == project_id]) == 3
    assert '已删除资料' in renderer.evaluate("document.getElementById('pv-feedback').textContent")

    click(renderer, 'pv-overview')
    overview_id = next(record['id'] for record in after_file_delete['records'] if record['project'] == project_id)
    renderer.evaluate('document.querySelector(\'[data-delete-record="' + overview_id + '"]\').click(); true')
    answer_delete(renderer, True)
    renderer.wait("document.querySelectorAll('#pv-content .pv-overview-item').length === 2")
    assert renderer.evaluate("document.getElementById('pv-title').textContent") == '项目完整预览'

    # The project confirmation must give its scope, and cancelling must leave bytes intact.
    before_project_delete = renderer.evaluate('window.vaultApp.load()')['store']
    before_cancel = (data_root / 'vault.dat').read_bytes()
    click(renderer, 'pv-project-delete')
    renderer.wait("document.getElementById('pv-confirm-dialog').open")
    assert renderer.evaluate("document.getElementById('pv-confirm-title').textContent") == '删除项目？'
    assert renderer.evaluate("document.getElementById('pv-confirm-name').textContent") == '安装包验证项目'
    assert '2 份资料' in renderer.evaluate("document.getElementById('pv-confirm-scope').textContent")
    capture(main, 'custom-delete-confirmation.png')
    assert renderer.evaluate("getComputedStyle(document.getElementById('pv-confirm-dialog'), '::backdrop').backgroundColor !== 'rgba(0, 0, 0, 0)'")
    main.evaluate("globalThis.__pvOriginalSize = globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].getSize(); globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].setSize(760,600); true")
    capture(main, 'custom-delete-small-window.png')
    assert renderer.evaluate("(() => { const rect=document.getElementById('pv-confirm-dialog').getBoundingClientRect(); return rect.left>=0 && rect.top>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight; })()")
    main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].setSize(...globalThis.__pvOriginalSize); true")
    # Focus must cycle within the modal; Esc cancels and restores its trigger.
    for _ in range(5):
        press_key(renderer, 'Tab', 'Tab', 9)
        assert renderer.evaluate("Boolean(document.activeElement.closest('#pv-confirm-dialog'))")
    press_key(renderer, 'Escape', 'Escape', 27)
    renderer.wait("!document.getElementById('pv-confirm-dialog').open")
    assert renderer.evaluate("document.activeElement.id") == 'pv-project-delete'
    assert (data_root / 'vault.dat').read_bytes() == before_cancel

    # A disk failure must restore the in-memory project, files, and selection.
    main.evaluate("globalThis.__pvFs = process.getBuiltinModule('fs/promises'); globalThis.__pvOriginalRename = globalThis.__pvFs.rename; globalThis.__pvFs.rename = async () => { globalThis.__pvFs.rename = globalThis.__pvOriginalRename; throw new Error('测试保存失败'); }; true")
    click(renderer, 'pv-project-delete')
    answer_delete(renderer, True)
    renderer.wait("document.getElementById('pv-save-status').textContent === '保存失败'")
    assert renderer.evaluate('window.vaultApp.load()')['store'] == before_project_delete
    assert renderer.evaluate("document.getElementById('pv-project').value") == project_id
    assert renderer.evaluate("document.querySelectorAll('#pv-content .pv-overview-item').length") == 2
    assert (data_root / 'vault.dat').read_bytes() == before_cancel

    click(renderer, 'pv-project-delete')
    answer_delete(renderer, True)
    renderer.wait('!Array.from(document.getElementById("pv-project").options).some(option => option.value === ' + json.dumps(project_id) + ')')
    after_project_delete = renderer.evaluate('window.vaultApp.load()')['store']
    assert project_id not in after_project_delete['projects']
    assert not any(record['project'] == project_id for record in after_project_delete['records'])
    assert after_project_delete['projects'] == {key: value for key, value in before_project_delete['projects'].items() if key != project_id}
    assert after_project_delete['records'] == [record for record in before_project_delete['records'] if record['project'] != project_id]

    # Removing the final project must produce a usable empty state, preserved on restart.
    for remaining_id in list(after_project_delete['projects']):
        set_value(renderer, 'pv-project', remaining_id)
        click(renderer, 'pv-project-delete')
        answer_delete(renderer, True)
        renderer.wait('!Array.from(document.getElementById("pv-project").options).some(option => option.value === ' + json.dumps(remaining_id) + ')')
    assert renderer.evaluate('window.vaultApp.load()')['store'] == {'schemaVersion': 1, 'projects': {}, 'records': []}
    assert renderer.evaluate("document.getElementById('pv-title').textContent") == '还没有项目'
    assert renderer.evaluate("document.getElementById('pv-project-delete').disabled && document.getElementById('pv-import-open').disabled && document.getElementById('pv-export-open').disabled")
    main.evaluate("globalThis.__pvElectron.BrowserWindow.getAllWindows()[0].webContents.send('app:command', 'export'); true")
    renderer.wait("!document.getElementById('pv-project-create').hidden")
    assert renderer.evaluate("document.getElementById('pv-export-pane').hidden")
    assert main.evaluate('globalThis.__pvNativeDialogCalls') == 0
finally:
    stop_app(process, main, renderer, log)

process, main, renderer, log = start_app('empty-restart')
try:
    assert renderer.evaluate('window.vaultApp.load()')['store'] == {'schemaVersion': 1, 'projects': {}, 'records': []}
    assert renderer.evaluate("document.getElementById('pv-title').textContent") == '还没有项目'
    click(renderer, 'pv-project-new')
    set_value(renderer, 'pv-project-name', '删除后重新创建', 'input')
    click(renderer, 'pv-project-create-save')
    renderer.wait("document.getElementById('pv-project').selectedOptions[0].textContent === '删除后重新创建'")
    assert not renderer.evaluate("document.getElementById('pv-import-open').disabled")
    click(renderer, 'pv-import-open')
    set_value(renderer, 'pv-import-editor', '删除后仍可正常导入', 'input')
    click(renderer, 'pv-import-add')
    renderer.wait("!document.getElementById('pv-library').hidden && document.getElementById('pv-save-status').textContent === '已加密保存'")
    assert renderer.evaluate("document.getElementById('pv-content').textContent") == '删除后仍可正常导入'
    assert renderer.evaluate("!document.getElementById('pv-delete').hidden && document.getElementById('pv-delete').textContent.includes('删除资料')")
    for format_name, (_, content) in contents.items():
        click(renderer, 'pv-import-open')
        set_value(renderer, 'pv-import-editor', content, 'input')
        click(renderer, 'pv-import-add')
        renderer.wait("!document.getElementById('pv-library').hidden && document.getElementById('pv-save-status').textContent === '已加密保存'")
        pasted = renderer.evaluate('window.vaultApp.load()')['store']['records'][-1]
        assert pasted['format'] == format_name
        assert pasted['source'] == content.replace('\r\n', '\n')
        assert pasted['name'].endswith({'text': '.txt', 'env': '.env', 'json': '.json', 'markdown': '.md'}[format_name])
    pasted_records = renderer.evaluate('window.vaultApp.load()')['store']['records']
    assert len({record['name'] for record in pasted_records}) == len(pasted_records)
    bundle_source = json.dumps({'kind': 'project-vault', 'version': 1, 'project': 'bundle', 'files': [{'name': 'settings.original.conf', 'format': 'env', 'content': '[bundle]\nACTIVE=true\n'}]})
    click(renderer, 'pv-import-open')
    set_value(renderer, 'pv-import-editor', bundle_source, 'input')
    assert renderer.evaluate("!document.getElementById('pv-import-bundle-label').hidden")
    click(renderer, 'pv-import-add')
    renderer.wait("!document.getElementById('pv-library').hidden && document.getElementById('pv-save-status').textContent === '已加密保存'")
    assert renderer.evaluate("document.getElementById('pv-title').textContent") == 'settings.original.conf'
    assert renderer.evaluate("document.querySelectorAll('#pv-content .pv-env-group').length") == 1
    renderer.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    capture(main, 'delete-controls.png')
    before_example = renderer.evaluate('window.vaultApp.load()')['store']
    click(renderer, 'pv-import-open')
    set_value(renderer, 'pv-import-editor', 'Unsaved example import draft', 'input')
    click(renderer, 'pv-project-example')
    assert renderer.evaluate("document.getElementById('pv-import-editor').value") == 'Unsaved example import draft'
    assert renderer.evaluate('window.vaultApp.load()')['store'] == before_example
    click(renderer, 'pv-import-back')
    click(renderer, 'pv-project-example')
    renderer.wait("document.getElementById('pv-project').selectedOptions[0].textContent === '标准示例项目'")
    example_project = renderer.evaluate("document.getElementById('pv-project').value")
    with_example = renderer.evaluate('window.vaultApp.load()')['store']
    assert len(with_example['records']) == len(before_example['records']) + 4
    assert [record for record in with_example['records'] if record['project'] != example_project] == before_example['records']
    assert all(with_example['projects'][key] == value for key, value in before_example['projects'].items())
    example_records = [record for record in with_example['records'] if record['project'] == example_project]
    assert [{'name': record['name'], 'format': record['format'], 'content': record['source']} for record in example_records] == standard['files']
    encrypted_before_duplicate = (data_root / 'vault.dat').read_bytes()
    click(renderer, 'pv-project-example')
    assert renderer.evaluate('window.vaultApp.load()')['store'] == with_example
    assert (data_root / 'vault.dat').read_bytes() == encrypted_before_duplicate
    select_record(renderer, example_records[0]['id'])
    click(renderer, 'pv-edit')
    set_value(renderer, 'pv-import-editor', example_records[0]['source'] + '\n个人修改应保留', 'input')
    click(renderer, 'pv-import-add')
    renderer.wait("!document.getElementById('pv-library').hidden")
    edited_example = renderer.evaluate('window.vaultApp.load()')['store']
    click(renderer, 'pv-project-example')
    renderer.wait("document.getElementById('pv-project').selectedOptions[0].textContent === '标准示例项目 (2)'")
    final_example = renderer.evaluate('window.vaultApp.load()')['store']
    assert final_example['records'][:len(edited_example['records'])] == edited_example['records']
    assert len(final_example['records']) == len(edited_example['records']) + 4
    # The separately distributed project JSON must follow the actual native-file import path.
    click(renderer, 'pv-project-new')
    set_value(renderer, 'pv-project-name', '示例资料包导入验证', 'input')
    click(renderer, 'pv-project-create-save')
    renderer.wait("document.getElementById('pv-project').selectedOptions[0].textContent === '示例资料包导入验证'")
    bundle_project = renderer.evaluate("document.getElementById('pv-project').value")
    main.evaluate("globalThis.__pvElectron.dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[" + json.dumps(str(app_root / 'release/project-vault-example.json')) + '] }); true')
    click(renderer, 'pv-import-open')
    click(renderer, 'pv-choose-file')
    renderer.wait("document.getElementById('pv-chosen-file').textContent === 'project-vault-example.json'")
    assert renderer.evaluate("!document.getElementById('pv-import-bundle-label').hidden && document.getElementById('pv-import-bundle').checked")
    click(renderer, 'pv-import-add')
    renderer.wait("!document.getElementById('pv-library').hidden && document.getElementById('pv-save-status').textContent === '已加密保存'")
    bundled_store = renderer.evaluate('window.vaultApp.load()')['store']
    bundled_files = [record for record in bundled_store['records'] if record['project'] == bundle_project]
    assert [{'name': record['name'], 'format': record['format'], 'content': record['source']} for record in bundled_files] == standard['files']
    assert bundled_store['records'][:len(final_example['records'])] == final_example['records']
finally:
    stop_app(process, main, renderer, log)

process, main, renderer, log = start_app('example-restart')
try:
    assert renderer.evaluate('window.vaultApp.load()')['store'] == bundled_store
finally:
    stop_app(process, main, renderer, log)

summary = {'status': 'passed', 'checks': ['packaged Windows executable', 'renderer isolation', 'Windows DPAPI encryption', 'native previews for all four types', 'native file import for all four types', 'removed import name/type form', 'paste format recognition, validation and automatic unique names', 'ENV sections in import, library, project and export previews', 'ENV preamble, repeated and empty sections, inline comments', 'ENV bracket values and quoted multiline values stay in their section', 'ENV multiline secrets remain masked', 'ENV group and whole-document copying', 'ENV export preserves exact source and CRLF', 'project JSON reimport preserves filenames', 'real file export in all four formats', 'project export', 'Markdown tables/code and inert HTML', 'save/edit preserves filename and type', 'encrypted backup', 'restart persistence', 'custom project selector search and keyboard selection', 'selector Escape/Tab and focus restoration', 'custom export selector', 'copy toast for document/code/export and error state', 'repeated copy/reset and toast auto-dismiss', 'cancel record/project deletion preserves encrypted data', 'custom confirmation scope and safe focus', 'modal Tab containment/Escape cancellation', 'zero native deletion dialogs', 'single record and overview record deletion', 'project deletion preserves other projects', 'save failure rolls back deletion', 'delete final project', 'empty state persists on restart', 'new project/import after deleting all projects'], 'asar_sha256': hashlib.sha256((executable.parent / 'resources' / 'app.asar').read_bytes()).hexdigest(), 'directory': str(check_root)}
summary['checks'] += ['TXT format labels across the UI', 'icon-only actions with accessible names and consistent sizes', 'custom tooltip on hover and keyboard focus, Escape dismisses', 'sensitive-value eye icon and label toggle together', 'copy checkmark keeps button size and restores accessible label']
summary['checks'] += ['rename via toolbar, real sidebar double-click, F2 and project overview', 'rename modal focus, Enter save and Escape cancel', 'blank, duplicate, invalid and overlong name validation', 'rename cancel and unchanged name preserve encrypted bytes', 'rename save failure rolls back and supports retry', 'rename updates sidebar, title, breadcrumb and export filename', 'rename all four types preserves exact content, IDs, type and other projects', 'renamed files persist after restart']
summary['checks'] += ['toast countdown shows 3, 2, 1 and dismisses in three seconds even on hover', 'repeated copy restarts countdown without early dismissal', 'countdown circle closes the toast and restores keyboard focus', 'reduced motion uses a static ring updated once per second']
summary['checks'] += ['ENV complete source on the left and separate INI sections on the right', 'ENV section headings and inline comments remain inside highlighted code', 'ENV columns stack in narrow import previews and small windows without horizontal overflow', 'complete ENV block copies masked or exact revealed source', 'toast fades before hiding and a new toast cancels any pending exit']
summary['checks'] += ['native menu removed and Alt does not reveal it', 'Ctrl+O and Ctrl+Shift+S open import and export without a menu', 'Ctrl+A selects editor text and zoom/reset shortcuts remain available']
summary['checks'] += ['updates disabled in isolated test mode', 'manual check result', 'update download progress and dismissal', 'ready notification reappears when download finishes', 'install requires custom confirmation and safe cancel/Escape', 'unsaved drafts block update installation', 'dismissed update reopens from footer', 'installer IPC only after confirmation', 'installation failure restores usable UI']
summary['checks'] += ['official version title and single standard first-run project', 'standard example opens without duplicate writes', 'example import preserves existing projects and documents', 'unsaved drafts block example import', 'standard bundle imports all four exact files', 'repeated example import preserves encrypted bytes', 'modified examples remain intact when a fresh numbered example is imported']
summary['checks'] += ['repository link opens metadata URL through validated IPC', 'full repository URL appears in a bounded tooltip', 'keyboard Tab and Enter activate the repository link']
summary['checks'] += ['published example ZIP restores every exact original file', 'standalone standard JSON native-file import preserves filenames, formats and content', 'existing and imported example data remain unchanged on restart']
(check_root / 'results.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
