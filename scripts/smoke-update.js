'use strict';

/**
 * End-to-end update/uninstall smoke test.
 *
 * Uses an isolated state dir, isolated plug-in folders and a file:// catalog
 * fixture, so no network or real plug-in folder is touched. Exercises:
 *   live catalog refresh → install → version comparison/update detection
 *   → platform download selection → checksum+size verification
 *   → app update check (release feed) → clean uninstall.
 *
 * Usage: npm run smoke:update
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const root = path.join(os.tmpdir(), 'kyrolll-update-smoke');
const stateDir = path.join(root, 'state');
const auDir = path.join(root, 'au');
const vstDir = path.join(root, 'vst3');
const catalogPath = path.join(root, 'catalog.json');
const feedPath = path.join(root, 'release-feed.json');
const demoZip = path.join(__dirname, '..', 'resources', 'demo', 'kyrolll-soul.zip');
const demoSha = crypto.createHash('sha256').update(fs.readFileSync(demoZip)).digest('hex');

fs.rmSync(root, { recursive: true, force: true });
for (const dir of [stateDir, auDir, vstDir]) fs.mkdirSync(dir, { recursive: true });

process.env.KYROLLL_STATE_DIR = stateDir;
process.env.KYROLLL_COMPONENTS_DIR = auDir;
process.env.KYROLLL_VST3_DIR = vstDir;
process.env.KYROLLL_CATALOG_URL = `file://${catalogPath}`;
process.env.KYROLLL_RELEASE_FEED_URL = `file://${feedPath}`;

const demoSize = fs.statSync(demoZip).size;

function writeCatalog(version) {
  const catalog = {
    schemaVersion: 2,
    channel: 'stable',
    app: {
      latestVersion: '1.1.0',
      releasedAt: '2026-11-24',
      releaseNotes: ['Catalog app release'],
      downloadPage: 'https://kyrolll.store',
    },
    plugins: [
      {
        id: 'kyrolll-soul',
        name: 'KYROlll SOUL',
        version,
        tagline: 'Analog soul, tape-worn and alive.',
        description: 'Smoke test entry.',
        identifier: 'store.kyrolll.soul',
        formats: ['AU', 'VST3'],
        size: demoSize,
        downloads: {
          mac: { url: 'demo://kyrolll-soul', sha256: demoSha, size: demoSize },
          win: { url: 'demo://kyrolll-soul', sha256: demoSha, size: demoSize },
        },
        releaseNotes: [`Smoke changelog for ${version}`, 'Second note'],
        order: 1,
      },
    ],
  };
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
}

writeCatalog('1.4.0');

fs.writeFileSync(
  feedPath,
  JSON.stringify({
    tag_name: 'v1.2.0',
    published_at: '2026-11-24T00:00:00Z',
    body: '- App release feed smoke note\n- Second app note',
    html_url: 'https://github.com/kyrolll/kyrolll/releases/tag/v1.2.0',
    assets: [
      { name: 'KYROlll-1.2.0.dmg', browser_download_url: 'https://example.com/KYROlll-1.2.0.dmg' },
      { name: 'KYROlll-Setup-1.2.0.exe', browser_download_url: 'https://example.com/KYROlll-Setup-1.2.0.exe' },
    ],
  }),
  'utf8'
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const { app } = require('electron');
const extractZip = require('extract-zip');

app.whenReady().then(async () => {
  try {
    const catalog = require('../src/main/catalog');
    const appUpdate = require('../src/main/appUpdate');
    const installer = require('../src/main/installer');
    const installedState = require('../src/main/installedState');
    const plugins = require('../src/main/plugins');
    const { pluginDirsFor, platformInfo } = require('../src/main/paths');

    // --- platform path logic (works from any host) -----------------------
    const savedVstDir = process.env.KYROLLL_VST3_DIR;
    delete process.env.KYROLLL_VST3_DIR;
    assert(platformInfo('win32').formats.join(',') === 'VST3', 'Windows should expose VST3 only');
    assert(pluginDirsFor('win32').AU === undefined, 'Windows should not expose an AU folder');
    assert(
      /Common Files[\\/]VST3$/.test(pluginDirsFor('win32').VST3),
      `Unexpected Windows VST3 path: ${pluginDirsFor('win32').VST3}`
    );
    process.env.KYROLLL_VST3_DIR = savedVstDir;
    console.log('platform paths ok');

    // --- live catalog refresh + app update check --------------------------
    await catalog.init();
    await catalog.refresh();
    const cs = catalog.getState();
    assert(cs.source === 'remote', `Expected remote catalog, got ${cs.source}`);
    assert(cs.catalog.app?.latestVersion === '1.1.0', 'Catalog app metadata missing');

    const appState = await appUpdate.check('1.0.0');
    assert(appState.info.updateAvailable, 'Release feed should report an app update');
    assert(appState.info.latestVersion === '1.2.0', `Expected feed version 1.2.0, got ${appState.info.latestVersion}`);
    assert(/\.dmg$/.test(appState.info.downloadUrl), `Expected macOS download URL, got ${appState.info.downloadUrl}`);
    console.log('app update check ok', appState.info.currentVersion, '→', appState.info.latestVersion);

    // --- install the catalog version -------------------------------------
    const plugin = catalog.findPlugin('kyrolll-soul');
    const record = await installer.runInstall({
      plugin,
      onProgress: (p) => {
        if (p.phase === 'done') console.log(' install progress reached 100%');
      },
    });
    assert(record.version === '1.4.0', `Expected installed 1.4.0, got ${record.version}`);
    assert(record.bundles.length === 2, `Expected 2 bundles, got ${record.bundles.length}`);

    let state = await installedState.read();
    let bundles = await plugins.scan();
    let views = plugins.buildPluginViews({ catalog: catalog.getState().catalog, state, bundles }).views;
    assert(views[0].status === 'installed', `Expected installed, got ${views[0].status}`);
    assert(views[0].installedVersion === '1.4.0', `Expected detected 1.4.0, got ${views[0].installedVersion}`);
    console.log('install + detection ok');

    // --- Windows-style bundle filtering ----------------------------------
    const extractDir = path.join(root, 'extracted');
    await extractZip(demoZip, { dir: extractDir });
    const allBundles = await installer.findBundles(extractDir, ['AU', 'VST3']);
    const winBundles = await installer.findBundles(extractDir, ['VST3']);
    assert(allBundles.length === 2, `Expected 2 macOS bundles, got ${allBundles.length}`);
    assert(winBundles.length === 1 && winBundles[0].format === 'VST3', 'Windows filter should keep only VST3');
    console.log('platform bundle filtering ok');

    // --- catalog bumps the version → update available -------------------
    writeCatalog('1.5.0');
    await catalog.refresh();
    state = await installedState.read();
    bundles = await plugins.scan();
    views = plugins.buildPluginViews({ catalog: catalog.getState().catalog, state, bundles }).views;
    assert(views[0].status === 'update-available', `Expected update-available, got ${views[0].status}`);
    assert(views[0].updateFrom === '1.4.0' && views[0].updateTo === '1.5.0', 'Version delta missing');
    assert(views[0].releaseNotes.length > 0, 'Changelog missing from update view');
    assert(views[0].platformDownload?.url, 'Platform download missing from update view');
    console.log('update detection ok', views[0].updateFrom, '→', views[0].updateTo);

    // --- clean uninstall removes bundles and state -----------------------
    const result = await installer.uninstallPlugin({
      pluginId: 'kyrolll-soul',
      plugin,
      record: state.plugins['kyrolll-soul'],
      detectedPaths: views[0].detectedPaths,
    });
    assert(result.removed.length === 2, `Expected 2 removed bundles, got ${result.removed.length}`);
    assert(fs.readdirSync(auDir).length === 0, 'AU folder should be empty after uninstall');
    assert(fs.readdirSync(vstDir).length === 0, 'VST3 folder should be empty after uninstall');

    state = await installedState.read();
    assert(!state.plugins['kyrolll-soul'], 'installed.json should no longer contain the plugin');
    bundles = await plugins.scan();
    views = plugins.buildPluginViews({ catalog: catalog.getState().catalog, state, bundles }).views;
    assert(views[0].status === 'not-installed', `Expected not-installed, got ${views[0].status}`);
    console.log('uninstall ok');

    console.log('SMOKE UPDATE OK');
  } catch (err) {
    console.error('SMOKE UPDATE FAIL:', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
