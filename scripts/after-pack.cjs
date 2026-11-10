const fs = require('node:fs/promises');
const path = require('node:path');

// A directory build followed by --prepackaged NSIS skips electron-builder's
// update-config hook. Include the same public feed in the tested directory too.
module.exports = async ({ appOutDir, packager }) => {
  if (packager.platform.name !== 'windows') return;
  const file = path.join(packager.getResourcesDir(appOutDir), 'app-update.yml');
  try { await fs.access(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const publish = packager.config.publish;
  if (!publish || publish.provider !== 'github') throw new Error('A GitHub update provider is required.');
  await fs.writeFile(file, JSON.stringify({ provider: 'github', owner: publish.owner, repo: publish.repo, updaterCacheDirName: packager.appInfo.updaterCacheDirName }, null, 2) + '\n', 'utf8');
};
