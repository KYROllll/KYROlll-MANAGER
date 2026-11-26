'use strict';

/**
 * Live update verification against the real OS plug-in folders.
 *
 * This is the opt-in, end-to-end check: it uses the real userData
 * installed.json, the real ~/Library/Audio/Plug-Ins folders and the real
 * repository catalog (which currently offers KYROlll SOUL 1.4.0). If 1.3.0 is
 * installed, it asserts that the app shows "UPDATE AVAILABLE", clicks Update,
 * waits for the install sheet to finish, then rescans the OS folders.
 *
 * Usage:
 *   npm run smoke:live-update
 *
 * The process uses an isolated Electron userData directory only for the
 * single-instance lock; KYROLLL_STATE_DIR still points at the real app state.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const realStateDir = path.join(os.homedir(), 'Library', 'Application Support', 'KYROlll MANAGER');
const testUserData = path.join(os.tmpdir(), `kyrolll-live-update-${process.pid}`);
const catalogPath = path.join(ROOT, 'catalog.json');

fs.rmSync(testUserData, { recursive: true, force: true });
fs.mkdirSync(testUserData, { recursive: true });

process.env.KYROLLL_STATE_DIR = realStateDir;
process.env.KYROLLL_CATALOG_URL = `file://${catalogPath}`;
process.env.KYROLLL_RELEASE_FEED_URL = 'off';
// No KYROLLL_COMPONENTS_DIR / KYROLLL_VST3_DIR overrides: use the real folders.

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function leftovers(dir) {
  try {
    return fs.readdirSync(dir).filter((entry) => /\.(staging|backup)-/.test(entry));
  } catch {
    return [];
  }
}

const { app } = require('electron');
app.setPath('userData', testUserData);

require('../src/main/main');

app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const installedState = require('../src/main/installedState');
      const plugins = require('../src/main/plugins');
      const { pluginDirs } = require('../src/main/paths');

      const before = await installedState.read();
      const beforeVersion = before.plugins?.['kyrolll-soul']?.version || null;
      console.log('installed.json before:', beforeVersion);
      console.log('AU folder:', pluginDirs.AU);
      console.log('VST3 folder:', pluginDirs.VST3);

      if (beforeVersion !== '1.3.0') {
        console.log(
          `SKIP LIVE UPDATE: expected KYROlll SOUL 1.3.0 installed, found ${beforeVersion || 'nothing'}.`
        );
        console.log('Install 1.3.0 first (or run the isolated npm run smoke:plugin-update).');
        app.quit();
        return;
      }

      let card = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        card = await win.webContents.executeJavaScript(`(() => {
          const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
          const button = document.querySelector('[data-action="install"][data-plugin-id="kyrolll-soul"]');
          const status = document.querySelector('.plugin-card .status');
          return {
            visible: Boolean(document.querySelector('.plugin-card')),
            status: status ? status.textContent.trim() : '',
            delta: text('.update-chip'),
            action: button ? button.textContent.trim() : '',
          };
        })()`);
        if (card.visible && card.status) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      console.log('catalog card:', JSON.stringify(card));
      assert(card.status === 'UPDATE AVAILABLE', `Expected UPDATE AVAILABLE, got "${card.status}"`);
      assert(card.delta.includes('1.3.0') && card.delta.includes('1.4.0'), `Unexpected delta: ${card.delta}`);
      assert(card.action === 'Update', `Expected the Update action, got "${card.action}"`);

      await win.webContents.executeJavaScript(
        "document.querySelector('[data-action=\"install\"][data-plugin-id=\"kyrolll-soul\"]').click()"
      );

      let sheet = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        sheet = await win.webContents.executeJavaScript(`(() => {
          const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
          return {
            success: Boolean(document.querySelector('.sheet-result.success')),
            result: text('.sheet-result.success'),
            detail: text('#progress-detail'),
            percent: text('#progress-percent'),
            steps: [...document.querySelectorAll('#step-list .step')].map((step) => ({
              label: step.querySelector('.step-label')?.textContent?.trim() || '',
              detail: step.querySelector('.step-detail')?.textContent?.trim() || '',
              done: step.classList.contains('is-done'),
            })),
          };
        })()`);
        if (sheet.success) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      console.log('install sheet:', JSON.stringify(sheet));
      assert(sheet.success, 'Install sheet never reached the success state');
      assert(/up to date/i.test(sheet.result), `Unexpected success text: ${sheet.result}`);
      assert(sheet.steps.every((step) => step.done), 'Every install step should be complete');
      assert(
        sheet.steps.some((step) => /Downloading archive/i.test(step.label) && /KB|MB|package|Downloaded/i.test(step.detail)),
        `Download step did not report bytes: ${JSON.stringify(sheet.steps)}`
      );
      assert(
        sheet.steps.some((step) => /Extracting archive/i.test(step.label) && /files/i.test(step.detail)),
        `Extract step did not report files: ${JSON.stringify(sheet.steps)}`
      );
      assert(
        sheet.steps.some((step) => /Installing/i.test(step.label) && /Placed/i.test(step.detail)),
        `Install step did not report placed bundles: ${JSON.stringify(sheet.steps)}`
      );

      // Rescan the real OS folders through the same code the app uses.
      const bundles = await plugins.scan();
      const soul = bundles.filter((bundle) => bundle.identifier?.startsWith('store.kyrolll.soul') || /KYROlll SOUL/.test(bundle.name));
      console.log('bundles on disk:', soul.map((bundle) => `${bundle.format}:${bundle.path}@${bundle.version}`));
      assert(soul.length === 2, `Expected AU + VST3 bundles, got ${soul.length}`);
      assert(soul.every((bundle) => bundle.version === '1.4.0'), `Expected 1.4.0 on disk, got ${soul.map((b) => b.version)}`);
      assert(fs.existsSync(path.join(pluginDirs.AU, 'KYROlll SOUL.component')), 'AU bundle missing from the OS folder');
      assert(fs.existsSync(path.join(pluginDirs.VST3, 'KYROlll SOUL.vst3')), 'VST3 bundle missing from the OS folder');
      assert(leftovers(pluginDirs.AU).length === 0, 'AU staging/backup leftovers found');
      assert(leftovers(pluginDirs.VST3).length === 0, 'VST3 staging/backup leftovers found');

      const after = await installedState.read();
      assert(after.plugins['kyrolll-soul']?.version === '1.4.0', 'installed.json was not updated to 1.4.0');
      console.log('installed.json after:', after.plugins['kyrolll-soul'].version);
      console.log('LIVE UPDATE OK: KYROlll SOUL 1.3.0 → 1.4.0 installed in the OS folders');
    } catch (err) {
      console.error('LIVE UPDATE FAIL:', err.stack || err.message);
      process.exitCode = 1;
    } finally {
      fs.rmSync(testUserData, { recursive: true, force: true });
      app.quit();
    }
  });
});
