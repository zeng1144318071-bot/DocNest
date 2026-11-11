const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, session, Menu, Tray, nativeImage, nativeTheme } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createUpdates } = require('./updates.cjs');
const { createMacUpdates } = require('./mac-updates.cjs');

const testMode = process.env.PROJECT_VAULT_TEST_MODE === '1';
if (testMode && process.env.PROJECT_VAULT_TEST_DATA_DIR) {
  const directory = path.resolve(process.env.PROJECT_VAULT_TEST_DATA_DIR);
  if (directory === path.parse(directory).root) throw new Error('A data directory is required.');
  app.setPath('userData', directory);
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'ProjectVaultPreview'));
}
app.setName('DocNest');
if (process.platform === 'win32') app.setAppUserModelId('local.projectvault.preview');
if (!testMode && !app.requestSingleInstanceLock()) app.exit(0);
let mainWindow;
let tray;
let readableVault = false;
let saveQueue = Promise.resolve();
let updates;
let installingUpdate = false;
let quitting = false;
const fileFormats = new Set(['text', 'env', 'json', 'markdown']);
const vaultDirectory = () => app.getPath('userData');
const vaultFile = () => path.join(vaultDirectory(), 'vault.dat');
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
app.on('second-instance', showMainWindow);

function requireRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('请求来源无效。');
}
function validateStore(value) {
  if (!value || value.schemaVersion !== 1 || !value.projects || Array.isArray(value.projects) || typeof value.projects !== 'object' || !Array.isArray(value.records)) throw new Error('资料库格式无效。');
  const projectKeys = Object.keys(value.projects);
  if (projectKeys.length > 1000 || value.records.length > 10000) throw new Error('资料数量无效。');
  for (const key of projectKeys) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || typeof value.projects[key] !== 'string' || !value.projects[key].trim() || value.projects[key].length > 200) throw new Error('项目名称无效。');
  }
  const ids = new Set();
  const records = value.records.map(record => {
    if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id) || !Object.hasOwn(value.projects, record.project) || !fileFormats.has(record.format) || typeof record.name !== 'string' || !record.name.trim() || record.name.length > 255 || typeof record.source !== 'string' || record.source.length > 10 * 1024 * 1024) throw new Error('资料内容无效或文件过大。');
    ids.add(record.id);
    return { id: record.id, project: record.project, name: record.name, format: record.format, source: record.source, note: typeof record.note === 'string' ? record.note.slice(0, 500) : '' };
  });
  return { schemaVersion: 1, projects: Object.fromEntries(projectKeys.map(key => [key, value.projects[key]])), records };
}
async function readVault() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用，暂时无法读取或保存资料。');
  await fs.mkdir(vaultDirectory(), { recursive: true });
  let encrypted;
  try { encrypted = await fs.readFile(vaultFile()); }
  catch (error) { if (error.code === 'ENOENT') { readableVault = true; return null; } throw new Error('资料库文件读取失败。'); }
  try {
    const store = validateStore(JSON.parse(safeStorage.decryptString(encrypted)));
    readableVault = true;
    return store;
  } catch (_) {
    throw new Error('资料库无法解密或已损坏。请使用创建它的系统账户，并保留 vault.dat 和 vault.prev.dat 文件。');
  }
}
async function writeVault(store) {
  if (!readableVault || !safeStorage.isEncryptionAvailable()) throw new Error('资料库尚未成功解锁，无法保存。');
  const encrypted = safeStorage.encryptString(JSON.stringify(store));
  const temporary = path.join(vaultDirectory(), 'vault.next.dat');
  await fs.writeFile(temporary, encrypted);
  try { await fs.copyFile(vaultFile(), path.join(vaultDirectory(), 'vault.prev.dat')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.rename(temporary, vaultFile());
  return { saved: true };
}
function safeFilename(value) {
  const name = path.basename(String(value)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? '项目资料.txt' : name;
}

app.whenReady().then(async () => {
  ipcMain.handle('vault:load', async event => {
    requireRenderer(event);
    return { store: await readVault(), version: app.getVersion(), directory: vaultDirectory(), platform: process.platform, protection: process.platform === 'darwin' ? 'macOS 钥匙串加密' : 'Windows 账户加密' };
  });
  ipcMain.handle('vault:save', async (event, value) => {
    requireRenderer(event);
    if (installingUpdate) throw new Error('正在准备安装更新，请稍后再试。');
    const snapshot = validateStore(value);
    const pending = saveQueue.then(() => writeVault(snapshot));
    saveQueue = pending.catch(() => {});
    await pending;
    return { saved: true };
  });
  ipcMain.handle('file:open', async event => {
    requireRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, { title: '导入资料', properties: ['openFile'], filters: [{ name: 'TXT / ENV / JSON / Markdown', extensions: ['txt', 'env', 'json', 'md', 'markdown'] }, { name: '所有文件（包含 .env.*）', extensions: ['*'] }] });
    if (result.canceled || !result.filePaths.length) return null;
    const target = result.filePaths[0];
    const info = await fs.stat(target);
    if (info.size > 10 * 1024 * 1024) throw new Error('支持导入 10 MB 以内的文本文件。');
    const data = await fs.readFile(target);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let content;
    try {
      content = data[0] === 0xff && data[1] === 0xfe ? new TextDecoder('utf-16le').decode(data) : decoder.decode(data);
    } catch (_) { content = new TextDecoder('gb18030').decode(data); }
    if (content.includes('\0')) throw new Error('请选择文本、ENV、JSON 或 Markdown 文件。');
    return { name: path.basename(target), content: content.replace(/^\uFEFF/, '') };
  });
  ipcMain.handle('file:save', async (event, value) => {
    requireRenderer(event);
    if (!value || typeof value.content !== 'string' || typeof value.name !== 'string' || !fileFormats.has(value.format)) throw new Error('导出内容无效。');
    const extensions = { text: ['txt'], env: ['env'], json: ['json'], markdown: ['md'] };
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出资料', defaultPath: path.join(app.getPath('downloads'), safeFilename(value.name)), filters: [{ name: value.format.toUpperCase(), extensions: extensions[value.format] }, { name: '所有文件', extensions: ['*'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, value.content, 'utf8');
    return { canceled: false, name: path.basename(result.filePath) };
  });
  ipcMain.handle('app:data-directory', event => { requireRenderer(event); return shell.openPath(vaultDirectory()); });
  const updateEnabled = app.isPackaged && !testMode && process.platform === 'win32';
  const macUpdateEnabled = app.isPackaged && !testMode && process.platform === 'darwin';
  const repositoryUrl = new URL(require('./package.json').repository.url);
  const [owner, repo] = repositoryUrl.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (repositoryUrl.hostname !== 'github.com' || !owner || !repo) throw new Error('更新仓库地址无效。');
  const onUpdateState = state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', state); };
  const createUpdater = () => {
    const updater = new (require('electron-updater').NsisUpdater)();
    updater.logger = null;
    return updater;
  };
  const updater = updateEnabled ? createUpdater() : null;
  updates = macUpdateEnabled ? createMacUpdates({
    version: app.getVersion(), owner, repo,
    downloadDirectory: app.getPath('downloads'),
    fetchResource: (...args) => session.fromPartition('docnest-updates').fetch(...args),
    openFile: filename => shell.openPath(filename), onState: onUpdateState
  }) : createUpdates({
    updater, createUpdater, enabled: updateEnabled, version: app.getVersion(),
    onState: onUpdateState,
    beforeInstall: async () => {
      await saveQueue;
      if (!readableVault) throw new Error('请先成功读取资料库，再安装更新。');
      try { await fs.copyFile(vaultFile(), path.join(vaultDirectory(), 'vault.before-update.dat')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('加密资料备份失败，请稍后重试。'); }
      quitting = true;
    }
  });
  ipcMain.handle('update:state', event => { requireRenderer(event); return updates.getState(); });
  ipcMain.handle('update:check', event => { requireRenderer(event); return updates.check(); });
  ipcMain.handle('update:install', async event => {
    requireRenderer(event);
    if (installingUpdate) throw new Error('正在准备安装更新。');
    installingUpdate = true;
    try { return await updates.install(); }
    finally { if (updates.getState().status !== 'installing') { installingUpdate = false; quitting = false; } }
  });
  ipcMain.handle('app:external-link', async (event, value) => {
    requireRenderer(event);
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('链接无效。'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('仅支持打开 HTTP 或 HTTPS 链接。');
    await shell.openExternal(url.href);
  });

  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { label: 'DocNest', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'windowMenu' }
  ]) : null);
  mainWindow = new BrowserWindow({ title: 'DocNest', width: 1220, height: 900, minWidth: 760, minHeight: 600, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#181e27' : '#ffffff', icon: path.join(__dirname, 'dist-ui', 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: testMode || !app.isPackaged } });
  if (process.platform === 'win32') {
    mainWindow.on('close', event => {
      if (quitting) return;
      event.preventDefault();
      mainWindow.hide();
    });
    if (!testMode) {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'dist-ui', 'icon.png')).resize({ width: 16, height: 16 });
      tray = new Tray(icon);
      tray.setToolTip('DocNest');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开 DocNest', click: showMainWindow },
        { type: 'separator' },
        { label: '退出 DocNest', click: () => app.quit() }
      ]));
      tray.on('click', showMainWindow);
      tray.on('double-click', showMainWindow);
    }
  }
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing || input.alt) return;
    const key = input.key.toLowerCase();
    if (input.control || input.meta) {
      if (key === 'o' && !input.shift) mainWindow.webContents.send('app:command', 'import');
      else if (key === 's' && input.shift) mainWindow.webContents.send('app:command', 'export');
      else if (key === '0' && !input.shift) mainWindow.webContents.setZoomLevel(0);
      else if (key === '+' || key === '=') mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5);
      else if (key === '-') mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5);
      else return;
    } else if (key === 'f11' && !input.shift) mainWindow.setFullScreen(!mainWindow.isFullScreen());
    else return;
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_, callback) => callback({ cancel: true }));
  mainWindow.on('page-title-updated', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => { if (!testMode) mainWindow.show(); });
  await mainWindow.loadFile(path.join(__dirname, 'dist-ui', 'index.html'));
  updates.start();
}).catch(async () => {
  if (!testMode) await dialog.showMessageBox({ type: 'error', title: '启动失败', message: 'DocNest启动失败，请重新安装应用。' });
  app.exit(1);
});
app.on('before-quit', event => {
  updates?.dispose();
  if (quitting) return;
  event.preventDefault(); quitting = true;
  saveQueue.finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
