from pathlib import Path
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request

import websocket


root = Path(__file__).resolve().parent.parent
binary = root / 'release/mac-universal/DocNest.app/Contents/MacOS/DocNest'
assert binary.is_file(), 'Build the macOS universal app first.'


def free_port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


class Page:
    def __init__(self, port):
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=1) as response:
                    target = next(target for target in json.load(response) if target.get('type') == 'page')
                self.connection = websocket.create_connection(target['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)
                self.counter = 0
                return
            except (OSError, StopIteration, ValueError, websocket.WebSocketException):
                time.sleep(.2)
        raise RuntimeError('The packaged macOS app did not expose a renderer.')

    def evaluate(self, expression):
        self.counter += 1
        self.connection.send(json.dumps({'id': self.counter, 'method': 'Runtime.evaluate', 'params': {
            'expression': expression, 'returnByValue': True, 'awaitPromise': True
        }}))
        while True:
            response = json.loads(self.connection.recv())
            if response.get('id') == self.counter:
                if 'error' in response or 'exceptionDetails' in response.get('result', {}):
                    raise RuntimeError(str(response))
                return response['result']['result'].get('value')

    def wait(self, condition):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if self.evaluate(condition):
                return
            time.sleep(.1)
        raise AssertionError('Timed out: ' + condition)


with tempfile.TemporaryDirectory(prefix='docnest-mac-smoke-') as temporary:
    data = Path(temporary) / 'user-data'
    port = free_port()
    environment = {**os.environ, 'PROJECT_VAULT_TEST_MODE': '1', 'PROJECT_VAULT_TEST_DATA_DIR': str(data)}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    with (Path(temporary) / 'app.log').open('w') as log:
        process = subprocess.Popen([str(binary), f'--remote-debugging-port={port}'], env=environment, stdout=log, stderr=log)
        try:
            page = Page(port)
            page.wait("document.body?.dataset.appReady === 'true'")
            assert page.evaluate("document.getElementById('pv-save-status').textContent") == 'macOS 钥匙串加密'
            assert not page.evaluate("document.getElementById('pv-check-update').hidden")
            assert page.evaluate("window.vaultApp.load().then(value => value.platform)") == 'darwin'
            marker = 'MAC_SMOKE_ENCRYPTION_MARKER_12698'
            snapshot = {'schemaVersion': 1, 'projects': {'smoke': '验证项目'}, 'records': [
                {'id': 'one', 'project': 'smoke', 'name': 'demo.txt', 'format': 'text', 'source': marker}
            ]}
            page.evaluate('window.vaultApp.save(' + json.dumps(snapshot, ensure_ascii=False) + ')')
            loaded = page.evaluate('window.vaultApp.load().then(value => value.store)')
            assert loaded['records'][0]['source'] == marker
            assert marker.encode() not in (data / 'vault.dat').read_bytes()
            print(json.dumps({'status': 'passed', 'platform': 'darwin', 'checks': [
                'packaged universal app launched', 'macOS Keychain encryption', 'encrypted save and load',
                'macOS interface labels', 'manual DMG update button'
            ]}, ensure_ascii=False))
        finally:
            if 'page' in locals():
                page.connection.close()
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
