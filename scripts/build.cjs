const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('esbuild');
const { Resvg } = require('@resvg/resvg-js');

(async () => {
  const root = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(root, 'dist-ui'), { recursive: true });
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  for (const name of ['index.html', 'app.css']) await fs.copyFile(path.join(root, 'ui', name), path.join(root, 'dist-ui', name));
  await build({ entryPoints: [path.join(root, 'ui', 'renderer.js')], bundle: true, outfile: path.join(root, 'dist-ui', 'renderer.js'), platform: 'browser', target: 'chrome142', minify: true, legalComments: 'none' });
  const svg = await fs.readFile(path.join(root, 'build', 'icon.svg'), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
  await fs.writeFile(path.join(root, 'dist-ui', 'icon.png'), png);
  const { default: pngToIco } = await import('png-to-ico');
  await fs.writeFile(path.join(root, 'build', 'icon.ico'), await pngToIco(png));
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const notices = ['Third-party notices for Project Vault ' + metadata.version, 'Electron and Chromium notices are distributed beside the executable.'];
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  for (const [location, info] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!location || info.dev || info.link) continue;
    const directory = path.join(root, location);
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    notices.push('\n' + metadata.name + ' ' + metadata.version + '\nLicense: ' + metadata.license);
    const candidates = (await fs.readdir(directory)).filter(name => /^(licen[cs]e|notice|copying)(?:[.-]|$)/i.test(name));
    for (const file of candidates) { if ((await fs.stat(path.join(directory, file))).isFile()) notices.push(await fs.readFile(path.join(directory, file), 'utf8')); }
  }
  await fs.writeFile(path.join(root, 'dist-ui', 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'), 'utf8');
  console.log('Built local UI and Windows application icon.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
