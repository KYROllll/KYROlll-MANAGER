'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateDir = '/tmp/kyrolll-smoke/state';
const auDir = '/tmp/kyrolll-smoke/au';
const vstDir = '/tmp/kyrolll-smoke/vst3';
fs.rmSync('/tmp/kyrolll-smoke', { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(auDir, { recursive: true });
fs.mkdirSync(vstDir, { recursive: true });

process.env.KYROLLL_STATE_DIR = stateDir;
process.env.KYROLLL_COMPONENTS_DIR = auDir;
process.env.KYROLLL_VST3_DIR = vstDir;

const { app } = require('electron');

app.whenReady().then(async () => {
  try {
    const catalog = require('../src/main/catalog');
    const installer = require('../src/main/installer');
    const installedState = require('../src/main/installedState');
    const plugins = require('../src/main/plugins');

    await catalog.init();
    const cs = catalog.getState();
    console.log('source', cs.source, 'error', cs.error);
    console.log('catalog', JSON.stringify(cs.catalog, null, 2).slice(0, 500));
    const plugin = cs.catalog.plugins[0];
    console.log('installing', plugin.id, plugin.version);

    const record = await installer.runInstall({
      plugin,
      onProgress: (p) => console.log(`  ${p.phase} ${p.percent}% ${p.detail || ''}`.trim()),
    });
    console.log('record:', JSON.stringify(record));

    const state = await installedState.read();
    console.log('state plugins:', Object.keys(state.plugins));

    const bundles = await plugins.scan();
    console.log('bundles found:', bundles.map((b) => `${b.format}:${b.name}@${b.version}`));

    const { views, untracked } = plugins.buildPluginViews({
      catalog: catalog.getState().catalog,
      state,
      bundles,
    });
    console.log('status:', views[0].status, 'version:', views[0].installedVersion);
    console.log('untracked:', untracked.length);

    if (views[0].status !== 'installed') throw new Error('Expected installed status');
    if (bundles.length !== 2) throw new Error('Expected 2 bundles');
    console.log('SMOKE OK');
  } catch (err) {
    console.error('SMOKE FAIL:', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
