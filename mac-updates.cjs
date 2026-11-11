const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { CHECK_INTERVAL, CHECK_TIMEOUT } = require('./updates.cjs');

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value || '');
  return match ? match.slice(1).map(Number) : null;
}

function newerVersion(latest, current) {
  const next = versionParts(latest);
  const installed = versionParts(current);
  if (!next || !installed) throw new Error('版本号无效。');
  return next.some((part, index) => part > installed[index] && next.slice(0, index).every((earlier, i) => earlier === installed[i]));
}

async function responseText(response, limit) {
  if (!response.ok || !response.body) throw new Error('更新服务器暂时不可用。');
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length;
    if (size > limit) throw new Error('更新信息过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function createMacUpdates({ version, owner, repo, downloadDirectory, fetchResource, openFile, onState = () => {}, timers = globalThis }) {
  let state = { status: 'idle', currentVersion: version, latestVersion: null, percent: 0, checkedAt: null, revision: 0, message: '' };
  let pendingCheck;
  let downloadPromise;
  let downloadedFile;
  let checkController;
  let downloadController;
  let startupTimer;
  let intervalTimer;
  let disposed = false;
  const getState = () => ({ ...state });
  const update = patch => {
    if (disposed) return;
    state = { ...state, ...patch, revision: state.revision + 1 };
    onState(getState());
  };
  const assetUrl = (tag, name) => `https://github.com/${owner}/${repo}/releases/download/${tag}/${name}`;

  async function saveDmg(url, filename, expectedSize, expectedHash, signal) {
    await fs.mkdir(downloadDirectory, { recursive: true });
    const preferred = path.join(downloadDirectory, filename);
    try {
      if ((await fileDigest(preferred)) === expectedHash) return preferred;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }

    const temporary = path.join(downloadDirectory, `.docnest-${randomUUID()}.download`);
    try {
      const response = await fetchResource(url, { signal });
      if (!response.ok || !response.body) throw new Error('安装包下载失败。');
      const hash = createHash('sha256');
      let received = 0;
      let lastProgress = 0;
      const progress = new Transform({ transform(chunk, _, callback) {
        received += chunk.length;
        if (received > expectedSize) return callback(new Error('安装包大小不符。'));
        hash.update(chunk);
        if (Date.now() - lastProgress > 150 || received === expectedSize) {
          lastProgress = Date.now();
          update({ percent: Math.min(100, Math.floor(received / expectedSize * 100)) });
        }
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      if (received !== expectedSize || hash.digest('hex') !== expectedHash) throw new Error('安装包校验失败，请重试。');

      for (let index = 1; index < 100; index++) {
        const destination = index === 1 ? preferred : path.join(downloadDirectory, filename.replace(/\.dmg$/, `-${index}.dmg`));
        try {
          await fs.link(temporary, destination);
          return destination;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      throw new Error('下载目录中已有过多同名安装包。');
    } finally { await fs.rm(temporary, { force: true }); }
  }

  function check() {
    if (disposed || state.status === 'downloading' || state.status === 'downloaded' || pendingCheck) return pendingCheck || Promise.resolve(getState());
    pendingCheck = (async () => {
      update({ status: 'checking', message: '', checkedAt: Date.now() });
      checkController = new AbortController();
      const timeout = timers.setTimeout(() => checkController.abort(), CHECK_TIMEOUT);
      try {
        const release = JSON.parse(await responseText(await fetchResource(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' }, signal: checkController.signal
        }), 1024 * 1024));
        if (release.draft || release.prerelease || !versionParts(release.tag_name)) throw new Error('版本信息无效。');
        if (!newerVersion(release.tag_name, version)) {
          update({ status: 'up-to-date', latestVersion: null, percent: 0 });
          return getState();
        }
        const latestVersion = release.tag_name.replace(/^v/, '');
        const filename = `DocNest-${latestVersion}-mac-universal.dmg`;
        const asset = release.assets?.find(item => item.name === filename && item.state === 'uploaded');
        const checksumAsset = release.assets?.find(item => item.name === 'SHA256SUMS-mac.txt' && item.state === 'uploaded');
        if (!asset || !checksumAsset || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 1024 ** 3) {
          throw new Error('新版 Mac 安装包尚未发布，请稍后重试。');
        }
        const checksums = await responseText(await fetchResource(assetUrl(release.tag_name, 'SHA256SUMS-mac.txt'), { signal: checkController.signal }), 4096);
        const line = checksums.split(/\r?\n/).find(item => item.endsWith(`  ${filename}`));
        const expectedHash = line?.slice(0, 64);
        if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash) || line !== `${expectedHash}  ${filename}`) throw new Error('安装包校验信息无效。');
        update({ status: 'downloading', latestVersion, percent: 0 });
        downloadController = new AbortController();
        downloadPromise = saveDmg(assetUrl(release.tag_name, filename), filename, asset.size, expectedHash.toLowerCase(), downloadController.signal)
          .then(filename => { downloadedFile = filename; update({ status: 'downloaded', percent: 100 }); })
          .catch(() => update({ status: 'error', percent: 0, message: '安装包下载或校验失败，请重新检查更新。' }))
          .finally(() => { downloadPromise = null; downloadController = null; });
        return getState();
      } catch (error) {
        if (!disposed) update({ status: 'error', percent: 0, message: error.message === '新版 Mac 安装包尚未发布，请稍后重试。' ? error.message : '检查更新失败，请检查网络后重试。' });
        return getState();
      } finally {
        timers.clearTimeout(timeout);
        checkController = null;
      }
    })().finally(() => { pendingCheck = null; });
    return pendingCheck;
  }

  function start() {
    if (disposed || intervalTimer) return;
    startupTimer = timers.setTimeout(() => { void check(); }, 1500);
    intervalTimer = timers.setInterval(() => { void check(); }, CHECK_INTERVAL);
    startupTimer?.unref?.(); intervalTimer?.unref?.();
  }
  async function install() {
    if (disposed || state.status !== 'downloaded' || !downloadedFile) throw new Error('新版本尚未下载完成。');
    const error = await openFile(downloadedFile);
    if (error) throw new Error('无法打开安装包，请到“下载”文件夹手动打开。');
    return getState();
  }
  function dispose() {
    disposed = true;
    timers.clearTimeout(startupTimer);
    timers.clearInterval(intervalTimer);
    checkController?.abort();
    downloadController?.abort();
  }
  return { getState, check, start, install, dispose };
}

module.exports = { createMacUpdates, newerVersion };
