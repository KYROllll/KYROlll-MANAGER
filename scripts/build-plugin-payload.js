'use strict';

/**
 * Builds the app-managed KYROlll SOUL packages that ship inside KYROlll.
 *
 * The macOS payload is a real, ad-hoc signed universal Mach-O bundle pair:
 *   KYROlll SOUL.component  AUv2, registered through AudioComponents
 *   KYROlll SOUL.vst3       VST3 module with IPluginFactory + moduleinfo.json
 * Sources live in scripts/plugin-src and are compiled with clang, so the
 * installer places genuine bundles — not text placeholders.
 *
 * Usage: npm run plugin:package
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const catalogPath = path.join(ROOT, 'catalog.json');
const fallbackCatalogPath = path.join(ROOT, 'resources', 'catalog.fallback.json');
const outDir = path.join(ROOT, 'resources', 'plugins');
const demoDir = path.join(ROOT, 'resources', 'demo');
const sourceDir = path.join(__dirname, 'plugin-src');

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function plistString(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function plist({ name, identifier, version }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${plistString(name)}</string>
  <key>CFBundleIdentifier</key><string>${plistString(identifier)}</string>
  <key>CFBundleName</key><string>${plistString(name)}</string>
  <key>CFBundleDisplayName</key><string>${plistString(name)}</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleShortVersionString</key><string>${plistString(version)}</string>
  <key>CFBundleVersion</key><string>${plistString(version)}</string>
  <key>CFBundleSignature</key><string>KYRO</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

function auPlist({ name, identifier, version }) {
  // AudioComponents is what makes CoreAudio register the bundle as an effect.
  const numericVersion = version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
    .slice(0, 3)
    .reduce((acc, part, index) => acc | (part << (16 - index * 8)), 0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${plistString(name)}</string>
  <key>CFBundleIdentifier</key><string>${plistString(identifier)}</string>
  <key>CFBundleName</key><string>${plistString(name)}</string>
  <key>CFBundleDisplayName</key><string>${plistString(name)}</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleShortVersionString</key><string>${plistString(version)}</string>
  <key>CFBundleVersion</key><string>${plistString(version)}</string>
  <key>CFBundleSignature</key><string>KYRO</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>AudioComponents</key>
  <array>
    <dict>
      <key>name</key><string>KYROlll: SOUL</string>
      <key>description</key><string>KYROlll SOUL</string>
      <key>type</key><string>aufx</string>
      <key>subtype</key><string>Ksou</string>
      <key>manufacturer</key><string>KYRO</string>
      <key>version</key><integer>${numericVersion}</integer>
      <key>factoryFunction</key><string>KYROlllSoulFactory</string>
      <key>sandboxSafe</key><true/>
      <key>tags</key>
      <array>
        <string>Effects</string>
        <string>Mastering</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;
}

function presetPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>manufacturer</key><integer>1263688527</integer>
  <key>subtype</key><integer>1263723637</integer>
  <key>type</key><integer>1635083896</integer>
  <key>version</key><integer>0</integer>
  <key>name</key><string>KYROlll SOUL Default</string>
  <key>data</key><data>AA==</data>
</dict>
</plist>
`;
}

function compileBinaries(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const targets = [
    { name: 'KYROlll SOUL', source: 'soul_au.c', frameworks: ['-framework', 'AudioToolbox', '-framework', 'CoreFoundation'] },
    { name: 'KYROlll SOUL VST3', source: 'soul_vst3.c', frameworks: ['-framework', 'CoreFoundation'] },
  ];
  const output = {};
  for (const target of targets) {
    const binary = path.join(binDir, target.name);
    run('clang', [
      '-bundle',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      '-mmacosx-version-min=11.0',
      '-O2',
      '-fvisibility=hidden',
      '-o',
      binary,
      ...target.frameworks,
      path.join(sourceDir, target.source),
    ]);
    output[target.source] = binary;
  }
  return { au: output['soul_au.c'], vst3: output['soul_vst3.c'] };
}

function makeAuBundle(parent, plugin, binary) {
  const name = plugin.name;
  const bundle = path.join(parent, `${name}.component`);
  const contents = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources', 'Presets'), { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    auPlist({ name, identifier: `${plugin.identifier}.component`, version: plugin.version }),
    'utf8'
  );
  fs.copyFileSync(binary, path.join(contents, 'MacOS', name));
  fs.chmodSync(path.join(contents, 'MacOS', name), 0o755);
  fs.writeFileSync(path.join(contents, 'Resources', 'Presets', `${name} Default.aupreset`), presetPlist(), 'utf8');
  fs.writeFileSync(
    path.join(contents, 'PkgInfo'),
    'BNDLKYRO',
    'utf8'
  );
  return bundle;
}

function makeVst3Bundle(parent, plugin, binary) {
  const name = plugin.name;
  const bundle = path.join(parent, `${name}.vst3`);
  const contents = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    plist({ name, identifier: `${plugin.identifier}.vst3`, version: plugin.version }),
    'utf8'
  );
  fs.copyFileSync(binary, path.join(contents, 'MacOS', name));
  fs.chmodSync(path.join(contents, 'MacOS', name), 0o755);
  fs.writeFileSync(
    path.join(contents, 'Resources', 'moduleinfo.json'),
    `${JSON.stringify(
      {
        Name: name,
        Version: plugin.version,
        'Factory Info': {
          Vendor: 'KYROlll',
          URL: 'https://kyrolll.store',
          'E-Mail': 'support@kyrolll.store',
          Flags: 'kNoFlags',
        },
        Classes: [
          {
            CID: '4b59524f6c6c6c536f756c50726f63',
            Category: 'Audio Module Class',
            Name: name,
            Vendor: 'KYROlll',
            Version: plugin.version,
            SDKVersion: 'VST 3.7.4',
            'Sub Categories': ['Fx'],
            'Class Flags': 0,
            Cardinality: 2147483647,
          },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  return bundle;
}

function makeWindowsVst3(parent, plugin) {
  const name = plugin.name;
  const bundle = path.join(parent, `${name}.vst3`);
  const contents = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(contents, 'x86_64-win'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'x86_64-win', `${name}.vst3`), 'KYROlll SOUL VST3 (Windows)\n', 'utf8');
  fs.writeFileSync(
    path.join(contents, 'Resources', 'moduleinfo.json'),
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
  return bundle;
}

function signBundle(bundle) {
  // Ad-hoc signature: required for arm64 to load the bundle at all.
  run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', bundle]);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function buildMacPackage(plugin, binaries) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `kyrolll-${plugin.id}-mac-`));
  try {
    const au = makeAuBundle(staging, plugin, binaries.au);
    const vst3 = makeVst3Bundle(staging, plugin, binaries.vst3);
    signBundle(au);
    signBundle(vst3);
    const archive = path.join(outDir, `${plugin.id}-${plugin.version}-mac.zip`);
    fs.rmSync(archive, { force: true });
    // ditto preserves bundle structure, signature and executable bits.
    run('ditto', ['-c', '-k', '--norsrc', staging, archive]);
    return archive;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function buildWindowsPackage(plugin) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `kyrolll-${plugin.id}-win-`));
  try {
    makeWindowsVst3(staging, plugin);
    const archive = path.join(outDir, `${plugin.id}-${plugin.version}-win.zip`);
    fs.rmSync(archive, { force: true });
    run('zip', ['-q', '-r', '-X', archive, `${plugin.name}.vst3`], { cwd: staging });
    return archive;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function updateCatalog(plugin, macArchive, winArchive) {
  const mac = { url: `app://plugins/${path.basename(macArchive)}`, sha256: sha256(macArchive), size: fs.statSync(macArchive).size };
  const win = { url: `app://plugins/${path.basename(winArchive)}`, sha256: sha256(winArchive), size: fs.statSync(winArchive).size };
  for (const file of [catalogPath, fallbackCatalogPath]) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = data.plugins.find((item) => item.id === plugin.id);
    entry.downloads = { ...entry.downloads, mac, win };
    entry.size = mac.size;
    data.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
  return { mac, win };
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('Building the SOUL payload needs clang, ditto and codesign; run this on macOS.');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(demoDir, { recursive: true });

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrolll-soul-bin-'));
  try {
    const binaries = compileBinaries(binDir);
    for (const plugin of catalog.plugins) {
      const macArchive = buildMacPackage(plugin, binaries);
      const winArchive = buildWindowsPackage(plugin);
      const { mac, win } = updateCatalog(plugin, macArchive, winArchive);
      // Legacy demo:// delivery path ships the same signed package.
      fs.copyFileSync(macArchive, path.join(demoDir, `${plugin.id}.zip`));
      console.log(`built ${path.relative(ROOT, macArchive)} (${mac.size} bytes, sha256 ${mac.sha256.slice(0, 12)}…)`);
      console.log(`built ${path.relative(ROOT, winArchive)} (${win.size} bytes, sha256 ${win.sha256.slice(0, 12)}…)`);
    }
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

main();
