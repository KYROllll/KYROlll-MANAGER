'use strict';

/**
 * Renderer smoke test.
 *
 * Boots the real KYROlll main process with a fixture catalog, then inspects the
 * rendered window: update badge + version delta + remove control, the app
 * update banner, and platform-aware footer. Exits non-zero on any mismatch.
 *
 * Usage: npm run smoke:ui
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.join(os.tmpdir(), 'kyrolll-ui-smoke');
const stateDir = path.join(root, 'state');
const auDir = path.join(root, 'au');
const vstDir = path.join(root, 'vst3');
const catalogPath = path.join(root, 'catalog.json');

fs.rmSync(root, { recursive: true, force: true });
for (const dir of [stateDir, auDir, vstDir]) fs.mkdirSync(dir, { recursive: true });

function plist(name, identifier, version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`;
}

function makeBundle(dir, name, extension, version) {
  const bundle = path.join(dir, `${name}.${extension}`);
  fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), plist(name, `store.kyrolll.soul.${extension}`, version), 'utf8');
  return bundle;
}

const auBundle = makeBundle(auDir, 'KYROlll SOUL', 'component', '1.3.0');
const vstBundle = makeBundle(vstDir, 'KYROlll SOUL', 'vst3', '1.3.0');

fs.writeFileSync(
  path.join(stateDir, 'installed.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      plugins: {
        'kyrolll-soul': {
          version: '1.3.0',
          installedAt: new Date().toISOString(),
          sourceUrl: 'demo://kyrolll-soul',
          bundles: [
            { format: 'AU', name: 'KYROlll SOUL.component', path: auBundle },
            { format: 'VST3', name: 'KYROlll SOUL.vst3', path: vstBundle },
          ],
        },
      },
    },
    null,
    2
  ),
  'utf8'
);

fs.writeFileSync(
  catalogPath,
  JSON.stringify(
    {
      schemaVersion: 2,
      channel: 'stable',
      app: {
        latestVersion: '999.0.0',
        releasedAt: '2026-11-24',
        releaseNotes: ['UI smoke app note'],
        downloads: {
          mac: { url: 'https://example.com/KYROlll-999.dmg' },
          win: { url: 'https://example.com/KYROlll-999.exe' },
        },
        downloadPage: 'https://kyrolll.store',
      },
      plugins: [
        {
          id: 'kyrolll-soul',
          name: 'KYROlll SOUL',
          version: '1.4.0',
          tagline: 'Analog soul, tape-worn and alive.',
          description: 'UI smoke entry.',
          identifier: 'store.kyrolll.soul',
          formats: ['AU', 'VST3'],
          downloads: {
            mac: { url: 'demo://kyrolll-soul' },
            win: { url: 'demo://kyrolll-soul' },
          },
          releaseNotes: ['UI smoke changelog line'],
          order: 1,
        },
      ],
    },
    null,
    2
  ),
  'utf8'
);

process.env.KYROLLL_STATE_DIR = stateDir;
process.env.KYROLLL_COMPONENTS_DIR = auDir;
process.env.KYROLLL_VST3_DIR = vstDir;
process.env.KYROLLL_CATALOG_URL = `file://${catalogPath}`;
process.env.KYROLLL_RELEASE_FEED_URL = '';

const { app } = require('electron');

// Keep the smoke run independent from a real installed KYROlll instance.
app.setPath('userData', stateDir);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Requiring main boots the real app (window, IPC, menus).
require('../src/main/main');

app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const readState = () =>
        win.webContents.executeJavaScript(`(() => {
          const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
          return {
            cards: document.querySelectorAll('.plugin-card').length,
            updateCards: document.querySelectorAll('.plugin-card.update-card').length,
            updateBadges: document.querySelectorAll('.update-badge').length,
            delta: text('.update-chip'),
            removeButtons: document.querySelectorAll('[data-action="uninstall"]').length,
            appUpdateVisible: !document.querySelector('#app-update').hidden,
            appUpdateTitle: text('#app-update-title'),
            appUpdateVersions: text('#app-update-version-line'),
            downloadAction: document.querySelector('#app-update-download')?.textContent?.trim() || '',
            platform: document.body.dataset.platform || '',
            footer: text('#platform-label'),
            titlebarBrand: Boolean(document.querySelector('.brand-wordmark-img--header')),
          };
        })()`);

      let state = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        state = await readState();
        if (state.cards > 0 && state.appUpdateVisible) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      console.log('ui state', JSON.stringify(state));
      assert(state.cards === 1, `Expected 1 plugin card, got ${state.cards}`);
      assert(state.updateCards === 1, 'Expected the plugin card to show update state');
      assert(state.updateBadges >= 1, 'Expected an update badge');
      assert(state.delta.includes('1.3.0') && state.delta.includes('1.4.0'), `Unexpected delta: ${state.delta}`);
      assert(state.removeButtons >= 1, 'Expected a remove control for the installed plugin');
      assert(state.appUpdateVisible, 'App update banner should be visible');
      assert(state.appUpdateVersions.includes('999.0.0'), 'App update version line missing latest version');
      assert(state.downloadAction === 'Download Update', 'App update download action missing');
      assert(state.platform === 'mac', `Unexpected platform: ${state.platform}`);
      assert(/^Built for macOS$/.test(state.footer), `Unexpected footer: ${state.footer}`);
      assert(state.titlebarBrand, 'KYROlll wordmark missing from the title bar');
      console.log('SMOKE UI OK');
    } catch (err) {
      console.error('SMOKE UI FAIL:', err.stack || err.message);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  });
});
