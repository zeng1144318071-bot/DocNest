export function createUpdateControls(root, { api, ui, refreshIcons, canInstall }) {
  const byId = id => root.querySelector('#' + id);
  const button = byId('pv-check-update');
  const card = byId('pv-update-card');
  const dialog = byId('pv-update-dialog');
  let state = { status: 'idle', revision: -1 };
  let dismissed = '';
  let manual = false;
  let installing = false;
  let returnFocus;
  function render() {
    const ready = state.status === 'downloaded';
    const downloading = state.status === 'downloading';
    const key = state.latestVersion + ':' + state.status;
    const visible = (ready || downloading || state.status === 'installing') && dismissed !== key;
    card.hidden = !visible;
    card.dataset.status = state.status;
    byId('pv-update-title').textContent = ready ? 'v' + state.latestVersion + ' 已准备好' : state.status === 'installing' ? '正在打开安装程序…' : '正在下载 v' + state.latestVersion;
    byId('pv-update-detail').textContent = ready ? '安装后重新打开，已保存的资料会保留。' : state.status === 'installing' ? '请按安装程序提示完成更新。' : '下载完成后提醒你安装，可继续使用。';
    const progress = byId('pv-update-progress');
    progress.hidden = !downloading;
    progress.value = state.percent || 0;
    progress.setAttribute('aria-valuetext', Math.floor(state.percent || 0) + '%');
    byId('pv-update-percent').hidden = !downloading;
    byId('pv-update-percent').textContent = Math.floor(state.percent || 0) + '%';
    byId('pv-update-install').hidden = !ready;
    byId('pv-update-dismiss').disabled = installing || state.status === 'installing';
    button.disabled = installing || ['checking', 'installing'].includes(state.status);
    button.dataset.updateReady = String(ready);
    ui.setAction(button, ready ? 'circle-arrow-up' : state.status === 'checking' ? 'loader-circle' : 'refresh-cw', ready ? '安装新版本 v' + state.latestVersion : state.status === 'checking' ? '正在检查更新' : '检查更新');
    refreshIcons();
  }
  function accept(next) {
    if (!next || next.revision < state.revision) return;
    const previous = state.status;
    state = next;
    if (state.status === 'error' && previous === 'installing') {
      installing = false;
      byId('pv-update-confirm').disabled = false;
      byId('pv-update-cancel').disabled = false;
      byId('pv-update-close').disabled = false;
      if (dialog.open) dialog.close();
      ui.toast('安装未开始', state.message, 'error');
    }
    render();
  }
  function installationIssue() {
    const issue = canInstall();
    if (issue) { ui.toast('暂时无法安装', issue, 'error'); return true; }
    return false;
  }
  function openInstall() {
    if (state.status !== 'downloaded' || installing || dialog.open || installationIssue()) return;
    if (root.querySelector('dialog[open]')) return;
    returnFocus = document.activeElement;
    byId('pv-update-confirm-version').textContent = '即将安装 v' + state.latestVersion + '。应用会关闭并重新打开，安装前自动备份已保存的加密资料。';
    dialog.showModal(); byId('pv-update-cancel').focus();
  }
  function closeInstall() { if (!installing) dialog.close(); }
  button.addEventListener('click', async () => {
    if (state.status === 'downloaded') { dismissed = ''; render(); openInstall(); return; }
    if (state.status === 'downloading') { dismissed = ''; render(); return; }
    if (manual) return;
    manual = true;
    try {
      accept(await api.checkUpdates());
      if (state.status === 'up-to-date') ui.toast('已是最新版本', '当前版本 v' + state.currentVersion + '，每 5 分钟自动检查。');
      else if (state.status === 'disabled') ui.toast('开发模式', '正式安装版支持自动检查更新。');
      else if (state.status === 'error') ui.toast('检查更新失败', state.message, 'error');
    } catch (_) { ui.toast('检查更新失败', '请稍后重试。', 'error'); }
    finally { manual = false; }
  });
  byId('pv-update-dismiss').addEventListener('click', () => { dismissed = state.latestVersion + ':' + state.status; render(); });
  byId('pv-update-install').addEventListener('click', openInstall);
  byId('pv-update-cancel').addEventListener('click', closeInstall);
  byId('pv-update-close').addEventListener('click', closeInstall);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeInstall(); });
  dialog.addEventListener('close', () => { if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus(); });
  byId('pv-update-confirm').addEventListener('click', async () => {
    if (installing || state.status !== 'downloaded' || installationIssue()) return;
    installing = true;
    for (const id of ['pv-update-confirm', 'pv-update-cancel', 'pv-update-close']) byId(id).disabled = true;
    render();
    try {
      const result = await api.installUpdate();
      if (result.status !== 'installing') throw new Error('安装未开始，请重新检查更新。');
      accept(result);
    } catch (error) {
      installing = false;
      for (const id of ['pv-update-confirm', 'pv-update-cancel', 'pv-update-close']) byId(id).disabled = false;
      dialog.close(); render(); ui.toast('安装未开始', String(error.message || '请稍后重试。'), 'error');
    }
  });
  api.onUpdate(accept);
  void api.updateState().then(accept).catch(() => {});
  render();
}
