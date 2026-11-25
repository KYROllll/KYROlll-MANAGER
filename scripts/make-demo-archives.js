'use strict';

/**
 * Builds the offline demo archives used by resources/catalog.fallback.json.
 * Each archive contains a minimal but structurally real AU and VST3 bundle
 * with an Info.plist, so installation, detection and version display all
 * exercise the production code path without a network connection.
 *
 * Usage: npm run demo:archive
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'catalog.fallback.json'), 'utf8'));
const outDir = path.join(ROOT, 'resources', 'demo');

function plist({ name, identifier, version }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleSignature</key><string>KYRO</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`;
}

function makeBundle(parent, name, extension, identifier, version) {
  const bundle = path.join(parent, `${name}.${extension}`);
  const contents = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    plist({ name, identifier, version }),
    'utf8'
  );
  // Placeholder Mach-O stand-in. Real releases ship the signed binary here.
  fs.writeFileSync(path.join(contents, 'MacOS', name), 'KYROlll demo bundle\n', { mode: 0o755 });
  fs.writeFileSync(path.join(contents, 'Resources', 'KYROlll.txt'), `KYROlll Hub demo bundle — ${name} ${version}\n`, 'utf8');
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('Demo archives use ditto and are macOS-only.');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  for (const plugin of catalog.plugins) {
    const url = (plugin.downloads && plugin.downloads.mac && plugin.downloads.mac.url) ||
      (plugin.download && plugin.download.url);
    if (!url || !url.startsWith('demo://')) continue;

    const slug = url.replace('demo://', '');
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), `kyrolll-${slug}-`));
    try {
      for (const format of plugin.formats) {
        const extension = format === 'AU' ? 'component' : 'vst3';
        const identifier = `${plugin.identifier}.${extension}`;
        makeBundle(staging, plugin.name, extension, identifier, plugin.version);
      }
      const archive = path.join(outDir, `${slug}.zip`);
      fs.rmSync(archive, { force: true });
      // ditto preserves bundle structure and executable bits.
      execFileSync('ditto', ['-c', '-k', '--norsrc', staging, archive], { stdio: 'inherit' });
      console.log(`built ${path.relative(ROOT, archive)} (${plugin.name} ${plugin.version})`);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

main();
