const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMacUpdates, newerVersion } = require('../mac-updates.cjs');

const filename = 'DocNest-1.0.10-mac-universal.dmg';
const payload = Buffer.from('synthetic Mac installer bytes');
const digest = createHash('sha256').update(payload).digest('hex');

async function fixture(t, { checksum = digest, data = payload, latest = 'v1.0.10', assets = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docnest-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const opened = [];
  const fetchResource = async url => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify({
      tag_name: latest, draft: false, prerelease: false,
      assets: assets ? [{ name: filename, size: payload.length, state: 'uploaded' }, { name: 'SHA256SUMS-mac.txt', state: 'uploaded' }] : []
    }));
    if (url.endsWith('/SHA256SUMS-mac.txt')) return new Response(`${checksum}  ${filename}\n`);
    if (url.endsWith('/' + filename)) return new Response(data);
    throw new Error('Unexpected request: ' + url);
  };
  const service = createMacUpdates({ version: '1.0.9', owner: 'example', repo: 'DocNest', downloadDirectory: directory, fetchResource,
    openFile: async file => { opened.push(file); return ''; } });
  t.after(() => service.dispose());
  async function settled() {
    for (let index = 0; index < 100; index++) {
      if (service.getState().status !== 'downloading') return service.getState();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Download did not settle.');
  }
  return { directory, calls, opened, service, settled };
}

test('compares stable versions without requiring intermediate releases', () => {
  assert.equal(newerVersion('v1.0.10', '1.0.9'), true);
  assert.equal(newerVersion('v1.2.0', '1.0.9'), true);
  assert.equal(newerVersion('v1.0.8', '1.0.9'), false);
  assert.equal(newerVersion('v1.0.9', '1.0.9'), false);
  assert.throws(() => newerVersion('v1.0.10-beta', '1.0.9'));
});

test('downloads the latest DMG, verifies its hash and opens it for manual installation', async t => {
  const f = await fixture(t);
  await f.service.check();
  assert.equal((await f.settled()).status, 'downloaded');
  assert.equal(f.service.getState().percent, 100);
  assert.deepEqual(await fs.readFile(path.join(f.directory, filename)), payload);
  await f.service.install();
  assert.deepEqual(f.opened, [path.join(f.directory, filename)]);
  assert.equal(f.calls.filter(url => url.endsWith('/' + filename)).length, 1);
  await f.service.check();
  assert.equal(f.calls.filter(url => url.endsWith('/' + filename)).length, 1);
});

test('checksum failure never exposes an installable package or leaves a partial download', async t => {
  const f = await fixture(t, { data: Buffer.from('synthetic Mac installer byteS') });
  await f.service.check();
  assert.equal((await f.settled()).status, 'error');
  await assert.rejects(f.service.install(), /尚未下载/);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('preserves an existing different file and reuses a matching package', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, filename), 'existing user file');
  await f.service.check();
  assert.equal((await f.settled()).status, 'downloaded');
  assert.equal(await fs.readFile(path.join(f.directory, filename), 'utf8'), 'existing user file');
  await f.service.install();
  assert.match(f.opened[0], /-2\.dmg$/);
  assert.deepEqual(await fs.readFile(f.opened[0]), payload);
});

test('does not download an older release or a release without a Mac package', async t => {
  const older = await fixture(t, { latest: 'v1.0.8' });
  assert.equal((await older.service.check()).status, 'up-to-date');
  const missing = await fixture(t, { assets: false });
  const state = await missing.service.check();
  assert.equal(state.status, 'error');
  assert.match(state.message, /尚未发布/);
  assert.equal(missing.calls.length, 1);
});
