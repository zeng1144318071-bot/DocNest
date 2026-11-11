const CHECK_INTERVAL = 5 * 60 * 1000;
const CHECK_TIMEOUT = 30 * 1000;

// Network and installer access stay in the main process. The renderer receives only
// this small state object, never installer paths or arbitrary download URLs.
function createUpdates({ updater, createUpdater, enabled, version, onState = () => {}, beforeInstall = async () => {}, timers = globalThis, now = Date.now }) {
  let state = { status: enabled ? 'idle' : 'disabled', currentVersion: version, latestVersion: null, percent: 0, checkedAt: null, revision: 0, message: '' };
  let pendingCheck;
  let installing = false;
  let disposed = false;
  let startupTimer;
  let intervalTimer;
  const listeners = [];
  let cancelCheck;
  const getState = () => ({ ...state });
  function update(patch) {
    if (disposed) return;
    state = { ...state, ...patch, revision: state.revision + 1 };
    onState(getState());
  }
  function failed() {
    update({ status: 'error', percent: 0, message: '暂时无法获取更新，请检查网络后重试。' });
  }
  function listen(name, callback) { updater.on(name, callback); listeners.push([name, callback]); }
  function configureUpdater() {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    listen('checking-for-update', () => update({ status: 'checking', message: '', checkedAt: now() }));
    listen('update-not-available', () => update({ status: 'up-to-date', latestVersion: null, percent: 0, message: '', checkedAt: now() }));
    listen('update-available', info => update({ status: 'downloading', latestVersion: info.version, percent: 0, message: '' }));
    listen('download-progress', progress => update({ status: 'downloading', percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)) }));
    listen('update-downloaded', info => update({ status: 'downloaded', latestVersion: info.version, percent: 100, message: '' }));
    listen('error', failed);
  }
  if (enabled) configureUpdater();
  function retireUpdater() {
    // An expired request may still complete. Prevent it from downloading or
    // emitting state into the new attempt; never reuse its pending promise.
    updater.autoDownload = false;
    for (const [name, listener] of listeners.splice(0)) updater.removeListener(name, listener);
    updater.on('error', () => {});
  }
  function check() {
    if (disposed || !enabled) return Promise.resolve(getState());
    if (pendingCheck) return pendingCheck;
    if (['downloading', 'downloaded', 'installing'].includes(state.status) || installing) return Promise.resolve(getState());
    // Assign before invoking the updater, so simultaneous manual/timer checks coalesce.
    pendingCheck = Promise.resolve().then(async () => {
      if (disposed) return getState();
      update({ status: 'checking', message: '', checkedAt: now() });
      let deadline;
      let expired = false;
      const activeUpdater = updater;
      const timeout = new Promise(resolve => {
        cancelCheck = () => { expired = true; resolve(null); };
        deadline = timers.setTimeout(() => {
          expired = true;
          retireUpdater();
          update({ status: 'error', percent: 0, message: '检查更新超时（30 秒），请检查网络后重试。' });
          if (createUpdater) { updater = createUpdater(); configureUpdater(); }
          resolve(null);
        }, CHECK_TIMEOUT);
      });
      try {
        const result = await Promise.race([activeUpdater.checkForUpdates(), timeout]);
        if (expired || disposed) return getState();
        // Downloads outlive the manifest check; their rejection also needs a handler.
        if (result?.downloadPromise) void result.downloadPromise.catch(failed);
        if (state.status === 'checking') update({ status: 'up-to-date', latestVersion: null, percent: 0 });
      } catch (_) { if (!expired) failed(); }
      finally { timers.clearTimeout(deadline); cancelCheck = null; }
      return getState();
    }).finally(() => { pendingCheck = null; });
    return pendingCheck;
  }
  function start() {
    if (disposed || !enabled || intervalTimer) return;
    startupTimer = timers.setTimeout(() => { void check(); }, 1500);
    intervalTimer = timers.setInterval(() => { void check(); }, CHECK_INTERVAL);
    startupTimer?.unref?.(); intervalTimer?.unref?.();
  }
  async function install() {
    if (disposed || !enabled || state.status !== 'downloaded' || installing) throw new Error('新版本尚未下载完成。');
    installing = true;
    try {
      await beforeInstall();
      if (disposed || state.status !== 'downloaded') throw new Error('更新状态已变化，请重新检查更新。');
      update({ status: 'installing', message: '' });
      try { updater.quitAndInstall(false, true); }
      catch (_) { failed(); throw new Error('安装未开始，请重新检查更新。'); }
      return getState();
    } finally { installing = false; }
  }
  function dispose() {
    disposed = true;
    timers.clearTimeout(startupTimer); timers.clearInterval(intervalTimer);
    cancelCheck?.();
    if (enabled) retireUpdater();
  }
  return { getState, check, start, install, dispose };
}

module.exports = { CHECK_INTERVAL, CHECK_TIMEOUT, createUpdates };
