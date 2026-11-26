'use strict';

/**
 * End-to-end app update download smoke test.
 *
 * Serves a small fake installer over local HTTP, points the catalog app
 * metadata at it, boots the real main process + renderer, clicks the in-app
 * "Download Update" action and verifies the installer lands in the downloads
 * folder with the button switching to "Show Installer".
 *
 * Usage: npm run smoke:app-download
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.join(os.tmpdir(), 'kyrolll-app-download-smoke');
const stateDir = path.join(root, 'state');
const downloadsDir = path.join(root, 'downloads');
const auDir = path.join(root, 'au');
const vstDir = path.join(root, 'vst3');
const catalogPath = path.join(root, 'catalog.json');

fs.rmSync(root, { recursive: true, force: true });
for (const dir of [stateDir, downloadsDir, auDir, vstDir]) fs.mkdirSync(dir, { recursive: true });

// A bare Electron test process reports Electron's version (33.x) as the app
// version, so the fixture release must be far newer to count as an update.
const installerName = 'KYROlll-MANAGER-999.0.0-arm64.dmg';
const installerBytes = Buffer.alloc(512 * 1024, 7);

let origin = '';
const server = http.createServer((req, res) => {
  if (req.url === `/${installerName}`) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': installerBytes.length,
    });
    res.end(installerBytes);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

server.listen(0, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(
    catalogPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        channel: 'stable',
        app: {
          latestVersion: '999.0.0',
          releasedAt: '2026-11-25',
          releaseNotes: ['In-app installer download smoke note'],
          downloads: {
            macArm64: { url: `${origin}/${installerName}`, size: installerBytes.length },
            macIntel: { url: `${origin}/${installerName}`, size: installerBytes.length },
            win: { url: `${origin}/${installerName}`, size: installerBytes.length },
          },
        },
        plugins: [
          {
            id: 'kyrolll-soul',
            name: 'KYROlll SOUL',
            version: '1.3.0',
            formats: ['AU', 'VST3'],
            identifier: 'store.kyrolll.soul',
            downloads: { mac: { url: 'demo://kyrolll-soul' }, win: { url: 'demo://kyrolll-soul' } },
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
  process.env.KYROLLL_RELEASE_FEED_URL = 'off';

  const { app } = require('electron');
  app.setPath('userData', stateDir);
  app.setPath('downloads', downloadsDir);

  require('../src/main/main');

  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log('renderer:', message);
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        // The renderer paints from the bundled snapshot first, then renders the
        // update banner, so wait for the banner before clicking.
        let clicked = null;
        for (let attempt = 0; attempt < 80 && !clicked; attempt += 1) {
          clicked = await win.webContents.executeJavaScript(`(() => {
            const banner = document.querySelector('#app-update');
            const button = document.querySelector('#app-update-download');
            if (!banner || banner.hidden || !button) return null;
            const label = button.textContent.trim();
            button.click();
            return label;
          })()`);
          if (!clicked) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert(clicked && clicked.startsWith('Download Update'), `Unexpected update button: ${clicked}`);

        let state = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          state = await win.webContents.executeJavaScript(`(() => {
            const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
            return {
              button: text('#app-update-download'),
              reveal: text('#app-update-reveal'),
              revealHidden: document.querySelector('#app-update-reveal').hidden,
              progress: text('#app-update-progress'),
              progressHidden: document.querySelector('#app-update-progress').hidden,
            };
          })()`);
          if (state.button === 'Install Update') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        console.log('download state', JSON.stringify(state));
        assert(state.button === 'Install Update', `Expected "Install Update", got "${state.button}"`);
        assert(!state.revealHidden && state.reveal === 'Show Installer', 'Expected a "Show Installer" action');
        assert(!state.progressHidden, 'Download progress line should be visible');
        assert(/INSTALLER READY/i.test(state.progress), `Unexpected progress line: ${state.progress}`);

        const file = path.join(downloadsDir, installerName);
        assert(fs.existsSync(file), `Installer was not downloaded to ${downloadsDir}`);
        assert(fs.readFileSync(file).length === installerBytes.length, 'Downloaded installer size mismatch');
        console.log('SMOKE APP DOWNLOAD OK');
      } catch (err) {
        console.error('SMOKE APP DOWNLOAD FAIL:', err.stack || err.message);
        process.exitCode = 1;
      } finally {
        server.close();
        app.quit();
      }
    });
  });
});
