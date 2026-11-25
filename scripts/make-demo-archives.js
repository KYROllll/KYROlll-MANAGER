'use strict';

/**
 * Builds the app-managed plug-in packages shipped inside KYROlll.
 * Each archive contains minimal but structurally real bundles so install,
 * detection, update and uninstall exercise the production code path without
 * a standalone public download. Real releases replace the payload binaries;
 * the app:// delivery path and packaging stay the same.
 *
 * Usage: npm run plugin:package
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const outDir = path.join(ROOT, 'resources', 'plugins');

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

function makeMacBundle(parent, name, extension, identifier, version) {
  const bundle = path.join(parent, `${name}.${extension}`);
  const contents = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist({ name, identifier, version }), 'utf8');
  // Placeholder Mach-O stand-in. Real releases ship the signed binary here.
  fs.writeFileSync(path.join(contents, 'MacOS', name), 'KYROlll demo bundle\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(contents, 'Resources', 'KYROlll.txt'),
    `KYROlll app-managed demo bundle — ${name} ${version}\n`,
    'utf8'
  );
}

function makeWindowsVst3(parent, plugin) {
  const name = plugin.name;
  const bundle = path.join(parent, `${name}.vst3`);
  const contents = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(contents, 'x86_64-win'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'x86_64-win', `${name}.vst3`),
    'KYROlll demo bundle\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(contents, 'Resources', 'KYROlll.txt'),
    `KYROlll app-managed demo bundle — ${name} ${plugin.version}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(contents, 'moduleinfo.json'),
    `${JSON.stringify(
      {
        Name: name,
        Version: plugin.version,
        BundleId: `${plugin.identifier}.vst3`,
        Classes: [],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function buildMacPackage(plugin, slug) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `kyrolll-${slug}-mac-`));
  try {
    for (const format of plugin.formats) {
      const extension = format === 'AU' ? 'component' : 'vst3';
      makeMacBundle(staging, plugin.name, extension, `${plugin.identifier}.${extension}`, plugin.version);
    }
    const archive = path.join(outDir, `${slug}-${plugin.version}-mac.zip`);
    fs.rmSync(archive, { force: true });
    // ditto preserves bundle structure and executable bits.
    execFileSync('ditto', ['-c', '-k', '--norsrc', staging, archive], { stdio: 'inherit' });
    return archive;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function buildWindowsPackage(plugin, slug) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `kyrolll-${slug}-win-`));
  try {
    makeWindowsVst3(staging, plugin);
    const bundleName = `${plugin.name}.vst3`;
    const archive = path.join(outDir, `${slug}-${plugin.version}-win.zip`);
    fs.rmSync(archive, { force: true });
    execFileSync('zip', ['-q', '-r', '-X', archive, bundleName], {
      cwd: staging,
      stdio: 'inherit',
    });
    return archive;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('Packaging uses ditto and zip; run this on macOS.');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  for (const plugin of catalog.plugins) {
    const slug = plugin.id;
    const macArchive = buildMacPackage(plugin, slug);
    const winArchive = buildWindowsPackage(plugin, slug);
    console.log(`built ${path.relative(ROOT, macArchive)}`);
    console.log(`built ${path.relative(ROOT, winArchive)}`);
  }
}

main();
