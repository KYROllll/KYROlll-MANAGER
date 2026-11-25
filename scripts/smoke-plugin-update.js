'use strict';

/**
 * Genuine plug-in update smoke test.
 *
 * Builds two real KYROlll SOUL bundle versions, installs 1.3.0, publishes
 * 1.4.0 in the catalog, then runs the exact in-app update path (the same
 * installer.runInstall the Update button calls) and verifies the bundles on
 * disk report the new version with no staging/backup leftovers.
 *
 * Usage: npm run smoke:plugin-update
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.join(os.tmpdir(), 'kyrolll-plugin-update-smoke');
const stateDir = path.join(root, 'state');
const auDir = path.join(root, 'au');
const vstDir = path.join(root, 'vst3');
const archiveDir = path.join(root, 'archives');
const catalogPath = path.join(root, 'catalog.json');

fs.rmSync(root, { recursive: true, force: true });
for (const dir of [stateDir, auDir, vstDir, archiveDir]) fs.mkdirSync(dir, { recursive: true });

process.env.KYROLLL_STATE_DIR = stateDir;
process.env.KYROLLL_COMPONENTS_DIR = auDir;
process.env.KYROLLL_VST3_DIR = vstDir;
process.env.KYROLLL_CATALOG_URL = `file://${catalogPath}`;
process.env.KYROLLL_RELEASE_FEED_URL = 'off';

function plist({ name, identifier, version }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
</dict>
</plist>
`;
}

/** Build a structurally real SOUL package for one version. */
function buildArchive(version) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrolll-soul-bundles-'));
  try {
    for (const [extension, format] of [
      ['component', 'AU'],
      ['vst3', 'VST3'],
    ]) {
      const bundle = path.join(staging, `KYROlll SOUL.${extension}`);
      const contents = path.join(bundle, 'Contents');
      fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
      fs.writeFileSync(
        path.join(contents, 'Info.plist'),
        plist({ name: 'KYROlll SOUL', identifier: `store.kyrolll.soul.${format.toLowerCase()}`, version }),
        'utf8'
      );
      fs.writeFileSync(path.join(contents, 'MacOS', 'KYROlll SOUL'), `KYROlll SOUL ${version}\n`, {
        mode: 0o755,
      });
    }
    const archive = path.join(archiveDir, `kyrolll-soul-${version}-mac.zip`);
    execFileSync('ditto', ['-c', '-k', '--norsrc', staging, archive], { stdio: 'inherit' });
    return archive;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeCatalog(version, archive) {
  const size = fs.statSync(archive).size;
  const download = { url: `file://${archive}`, sha256: sha256(archive), size };
  fs.writeFileSync(
    catalogPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        channel: 'stable',
        app: { latestVersion: '1.0.0', releasedAt: '2026-11-25', releaseNotes: ['App 1.0.0'] },
        plugins: [
          {
            id: 'kyrolll-soul',
            name: 'KYROlll SOUL',
            version,
            tagline: 'Analog soul, tape-worn and alive.',
            description: 'Plugin update smoke entry.',
            identifier: 'store.kyrolll.soul',
            formats: ['AU', 'VST3'],
            size,
            downloads: { mac: download, win: download },
            releaseNotes: [`SOUL ${version} notes`],
            order: 1,
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function leftovers(dir) {
  return fs.readdirSync(dir).filter((entry) => /\.(staging|backup)-/.test(entry));
}

const { app } = require('electron');

app.whenReady().then(async () => {
  try {
    if (process.platform !== 'darwin') {
      console.log('SMOKE PLUGIN UPDATE SKIPPED (macOS bundles only)');
      return;
    }

    const catalog = require('../src/main/catalog');
    const installer = require('../src/main/installer');
    const installedState = require('../src/main/installedState');
    const plugins = require('../src/main/plugins');

    const oldArchive = buildArchive('1.3.0');
    const newArchive = buildArchive('1.4.0');
    writeCatalog('1.3.0', oldArchive);

    await catalog.init();
    await catalog.refresh();
    const first = catalog.findPlugin('kyrolll-soul');
    assert(first?.version === '1.3.0', `Catalog version should be 1.3.0, got ${first?.version}`);

    let done = 0;
    await installer.runInstall({
      plugin: first,
      onProgress: (progress) => {
        if (progress.phase === 'done') done = progress.percent;
      },
    });
    assert(done === 100, `Install progress should finish at 100, got ${done}`);

    let bundles = await plugins.scan();
    let state = await installedState.read();
    let views = plugins.buildPluginViews({ catalog: catalog.getState().catalog, state, bundles }).views;
    assert(bundles.length === 2, `Expected 2 bundles on disk, got ${bundles.length}`);
    assert(views[0].status === 'installed', `Expected installed, got ${views[0].status}`);
    assert(views[0].installedVersion === '1.3.0', `Disk version should be 1.3.0, got ${views[0].installedVersion}`);
    console.log('SOUL 1.3.0 installed on disk');

    // Publish 1.4.0 and refresh exactly like the refresh button does.
    writeCatalog('1.4.0', newArchive);
    await catalog.refresh();
    const latest = catalog.findPlugin('kyrolll-soul');
    assert(latest?.version === '1.4.0', `Catalog should now offer 1.4.0, got ${latest?.version}`);

    state = await installedState.read();
    bundles = await plugins.scan();
    views = plugins.buildPluginViews({ catalog: catalog.getState().catalog, state, bundles }).views;
    assert(views[0].status === 'update-available', `Expected update-available, got ${views[0].status}`);
    assert(views[0].updateFrom === '1.3.0', `updateFrom should be 1.3.0, got ${views[0].updateFrom}`);
    assert(views[0].updateTo === '1.4.0', `updateTo should be 1.4.0, got ${views[0].updateTo}`);
    assert(views[0].platformDownload?.url === `file://${newArchive}`, 'Update should use the 1.4.0 download');
    console.log('update detected on disk', views[0].updateFrom, '→', views[0].updateTo);

    // The in-app Update button runs this same call.
    await installer.runInstall({ plugin: latest, onProgress: () => {} });

    bundles = await plugins.scan();
    state = await installedState.read();
    views = plugins.buildPluginViews({ catalog: catalog.getState().catalog, state, bundles }).views;
    assert(bundles.length === 2, `Expected 2 bundles after update, got ${bundles.length}`);
    assert(views[0].status === 'installed', `Expected installed after update, got ${views[0].status}`);
    assert(views[0].installedVersion === '1.4.0', `Disk version should be 1.4.0, got ${views[0].installedVersion}`);
    assert(views[0].missingFormats.length === 0, `Formats missing after update: ${views[0].missingFormats}`);
    assert(leftovers(auDir).length === 0 && leftovers(vstDir).length === 0, 'Staging/backup folders were left behind');
    console.log('in-app update replaced bundles on disk with 1.4.0');

    const result = await installer.uninstallPlugin({
      pluginId: 'kyrolll-soul',
      plugin: latest,
      record: state.plugins['kyrolll-soul'],
      detectedPaths: views[0].detectedPaths,
    });
    assert(result.removed.length === 2, `Expected 2 removed bundles, got ${result.removed.length}`);
    assert(fs.readdirSync(auDir).length === 0, 'AU folder should be empty after uninstall');
    assert(fs.readdirSync(vstDir).length === 0, 'VST3 folder should be empty after uninstall');

    state = await installedState.read();
    bundles = await plugins.scan();
    views = plugins.buildPluginViews({ catalog: catalog.getState().catalog, state, bundles }).views;
    assert(views[0].status === 'not-installed', `Expected not-installed, got ${views[0].status}`);
    console.log('uninstall cleared bundles and state');

    console.log('SMOKE PLUGIN UPDATE OK');
  } catch (err) {
    console.error('SMOKE PLUGIN UPDATE FAIL:', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
