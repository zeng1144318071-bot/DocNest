const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async root => {
  const bundle = require('../examples/project-vault-example.json');
  const { version } = require('../package.json');
  const destination = path.join(root, 'release', 'examples');
  await fs.mkdir(destination, { recursive: true });
  for (const file of bundle.files) {
    if (path.basename(file.name) !== file.name) throw new Error('Invalid example filename.');
    await fs.writeFile(path.join(destination, file.name), file.content, 'utf8');
  }
  await fs.copyFile(path.join(root, 'examples', 'project-vault-example.json'), path.join(destination, 'project-vault-example.json'));
  await fs.copyFile(path.join(root, 'examples', 'project-vault-example.json'), path.join(root, 'release', 'project-vault-example.json'));
  await fs.copyFile(path.join(root, 'examples', 'README.md'), path.join(destination, 'README.md'));
  // Use the same ZIP writer already provided by electron-builder, no new runtime dependency.
  const { archive } = require('app-builder-lib/out/targets/archive');
  const output = path.join(root, 'release', `DocNest-Examples-${version}.zip`);
  try { await fs.unlink(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await archive('zip', output, destination, { compression: 'maximum' });
};
