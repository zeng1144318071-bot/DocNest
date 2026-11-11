const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates, CHECK_INTERVAL, CHECK_TIMEOUT } = require('../updates.cjs');

function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0;
  const installs = [];
  updater.checkForUpdates = async () => { checks++; updater.emit('update-not-available', { version: '0.2.0' }); return {}; };
  updater.quitAndInstall = (...args) => installs.push(args);
  const timeouts = [], intervals = [], cleared = [];
  const timers = { setTimeout: (fn, delay) => { const timer = { fn, delay }; timeouts.push(timer); return timer; }, setInterval: (fn, delay) => { const timer = { fn, delay }; intervals.push(timer); return timer; }, clearTimeout: timer => cleared.push(timer), clearInterval: timer => cleared.push(timer) };
  const states = [];
  const service = createUpdates({ updater, enabled: true, version: '0.2.0', timers, now: () => 1234, onState: state => states.push(state), ...options });
  return { updater, service, installs, timeouts, intervals, cleared, states, checks: () => checks };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('checks at startup and every five minutes; start is idempotent and dispose clears timers', async () => {
  const f = fixture(); f.service.start(); f.service.start();
  assert.equal(CHECK_INTERVAL, 300000);
  assert.equal(f.timeouts.length, 1); assert.equal(f.intervals.length, 1);
  assert.equal(f.timeouts[0].delay, 1500); assert.equal(f.intervals[0].delay, 300000);
  f.timeouts[0].fn(); await tick(); f.intervals[0].fn(); await tick();
  assert.equal(f.checks(), 2); assert.equal(f.service.getState().checkedAt, 1234);
  f.service.dispose(); assert.ok(f.cleared.includes(f.timeouts[0])); assert.ok(f.cleared.includes(f.intervals[0]));
  await f.service.check(); assert.equal(f.checks(), 2);
  assert.equal(f.updater.listenerCount('update-downloaded'), 0);
});

test('development/test mode never schedules or calls an updater', async () => {
  const f = fixture({ enabled: false, updater: null });
  f.service.start(); assert.equal((await f.service.check()).status, 'disabled');
  assert.equal(f.timeouts.length, 0); assert.equal(f.intervals.length, 0);
  await assert.rejects(f.service.install(), /尚未下载/); f.service.dispose();
});

test('coalesces concurrent manual and timer requests', async () => {
  const f = fixture(); let resolve;
  f.updater.checkForUpdates = () => new Promise(done => { resolve = done; });
  const first = f.service.check(), second = f.service.check();
  assert.equal(first, second); await tick(); resolve({});
  assert.equal((await first).status, 'up-to-date');
  assert.ok(f.states.every((state, i) => i === 0 || state.revision > f.states[i - 1].revision));
});

test('automatically downloads stable upgrades but never installs on ordinary quit', () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, true); assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowPrerelease, false); assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.disableWebInstaller, true); assert.deepEqual(f.installs, []);
});

test('tracks progress, retains ready state and skips checks during download', async () => {
  const f = fixture(); f.updater.emit('update-available', { version: '0.3.0' });
  f.updater.emit('download-progress', { percent: 34.75 });
  assert.equal(f.service.getState().percent, 34.75);
  await f.service.check(); assert.equal(f.checks(), 0);
  f.updater.emit('download-progress', { percent: 120 }); assert.equal(f.service.getState().percent, 100);
  f.updater.emit('update-downloaded', { version: '0.3.0' });
  await f.service.check(); assert.equal(f.service.getState().status, 'downloaded'); assert.equal(f.checks(), 0);
});

test('check failures are caught and the next check retries successfully', async () => {
  const f = fixture(); const good = f.updater.checkForUpdates;
  f.updater.checkForUpdates = async () => { throw new Error('private network/path detail'); };
  assert.equal((await f.service.check()).status, 'error');
  assert.ok(!f.service.getState().message.includes('private'));
  f.updater.checkForUpdates = good;
  assert.equal((await f.service.check()).status, 'up-to-date');
});

test('download/checksum rejection never exposes an installable update', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '0.3.0' });
    return { downloadPromise: Promise.reject(new Error('sha512 checksum mismatch')) };
  };
  await f.service.check(); await tick();
  assert.equal(f.service.getState().status, 'error');
  await assert.rejects(f.service.install(), /尚未下载/); assert.deepEqual(f.installs, []);
});

test('waits for encrypted backup before install and blocks duplicate installation', async () => {
  let release; const f = fixture({ beforeInstall: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(f.service.install(), /尚未下载/);
  f.updater.emit('update-downloaded', { version: '0.3.0' });
  const pending = f.service.install();
  assert.deepEqual(f.installs, []); await assert.rejects(f.service.install(), /尚未下载/);
  release(); assert.equal((await pending).status, 'installing');
  assert.deepEqual(f.installs, [[false, true]]);
});

test('backup failure preserves ready state and permits retry without launching installer', async () => {
  let fail = true; const f = fixture({ beforeInstall: async () => { if (fail) throw new Error('backup failed'); } });
  f.updater.emit('update-downloaded', { version: '0.3.0' });
  await assert.rejects(f.service.install(), /backup failed/);
  assert.equal(f.service.getState().status, 'downloaded'); assert.deepEqual(f.installs, []);
  fail = false; await f.service.install(); assert.equal(f.installs.length, 1);
});

test('installer launch errors are reported and block accidental reinstall', async () => {
  const f = fixture(); f.updater.quitAndInstall = () => { throw new Error('spawn failed'); };
  f.updater.emit('update-downloaded', { version: '0.3.0' });
  await assert.rejects(f.service.install(), /安装未开始/);
  assert.equal(f.service.getState().status, 'error');
  await assert.rejects(f.service.install(), /尚未下载/);
});


test('stalled checks time out, retry on a fresh updater, and ignore late old events', async () => {
  const fresh = new EventEmitter();
  fresh.checkForUpdates = async () => { fresh.emit('update-not-available'); return {}; };
  const f = fixture({ createUpdater: () => fresh });
  let finish;
  f.updater.checkForUpdates = () => new Promise(resolve => { finish = resolve; });
  const pending = f.service.check();
  await tick();
  assert.equal(f.service.getState().status, 'checking');
  assert.equal(CHECK_TIMEOUT, 30000);
  f.timeouts.find(timer => timer.delay === CHECK_TIMEOUT).fn();
  assert.equal((await pending).status, 'error');
  assert.match(f.service.getState().message, /30 秒/);
  assert.equal(f.updater.autoDownload, false);
  assert.equal((await f.service.check()).status, 'up-to-date');
  f.updater.emit('update-available', { version: '9.0.0' });
  f.updater.emit('error', new Error('late failure'));
  finish({}); await tick();
  assert.equal(f.service.getState().status, 'up-to-date');
  f.service.dispose();
});

test('latest version may skip multiple releases without intermediate installation', async () => {
  const f = fixture({ version: '1.0.0' });
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '1.0.5' });
    f.updater.emit('update-downloaded', { version: '1.0.5' });
    return {};
  };
  const result = await f.service.check();
  assert.equal(result.latestVersion, '1.0.5');
  assert.equal(result.status, 'downloaded');
  await f.service.install();
  assert.equal(f.installs.length, 1);
});

test('disposing a stalled check settles it without late state changes', async () => {
  const f = fixture();
  f.updater.checkForUpdates = () => new Promise(() => {});
  const pending = f.service.check(); await tick();
  f.service.dispose(); await pending;
  const count = f.states.length;
  f.updater.emit('update-downloaded', { version: '9.0.0' });
  assert.equal(f.states.length, count);
});
