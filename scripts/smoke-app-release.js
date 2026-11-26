'use strict';

/**
 * End-to-end GitHub-release update smoke test.
 *
 * Serves a GitHub releases/latest-shaped feed with a higher version and an
 * installer asset, boots the real main process + renderer, and verifies that:
 *   - the app-update banner appears with the feed's version,
 *   - the catalog (1.0.0) does not mask the newer release,
 *   - "Download Update" streams the asset inside the app,
 *   - the button becomes "Install Update" with a "Show Installer" action.
 *
 * This is the same path used when a new vX.Y.Z GitHub release is published.
 *
 * Usage: npm run smoke:app-release
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.join(os.tmpdir(), 'kyrolll-app-release-smoke');
const stateDir = path.join(root, 'state');
const downloadsDir = path.join(root, 'downloads');
const auDir = path.join(root, 'au');
const vstDir = path.join(root, 'vst3');
const catalogPath = path.join(root, 'catalog.json');

fs.rmSync(root, { recursive: true, force: true });
for (const dir of [stateDir, downloadsDir, auDir, vstDir]) fs.mkdirSync(dir, { recursive: true });

// A bare Electron test process reports Electron's version, so the fixture
// release must be far newer to count as an update.
const releaseVersion = '999.0.0';
const installerName = `KYROlll-MANAGER-${releaseVersion}-arm64.dmg`;
const installerBytes = Buffer.alloc(640 * 1024, 9);

let origin = '';
const server = http.createServer((req, res) => {
  if (req.url === '/releases/latest') {
    const body = JSON.stringify({
      tag_name: `v${releaseVersion}`,
      name: `KYROlll MANAGER ${releaseVersion}`,
      published_at: '2026-11-26T00:00:00Z',
      body: '- New in-app installer handoff\n- Faster plug-in updates',
      html_url: `https://github.com/KYROllll/KYROlll-MANAGER/releases/tag/v${releaseVersion}`,
      assets: [
        {
          name: installerName,
          browser_download_url: `${origin}/${installerName}`,
          size: installerBytes.length,
        },
        {
          name: `KYROlll-MANAGER-Setup-${releaseVersion}.exe`,
          browser_download_url: `${origin}/KYROlll-MANAGER-Setup-${releaseVersion}.exe`,
          size: installerBytes.length,
        },
      ],
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
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
          // Deliberately older than the release feed: the feed must win.
          latestVersion: '1.0.0',
          releasedAt: '2026-11-25',
          releaseNotes: ['Catalog app note'],
          downloads: {
            macArm64: { url: 'https://example.com/KYROlll-MANAGER-1.0.0-arm64.dmg' },
            macIntel: { url: 'https://example.com/KYROlll-MANAGER-1.0.0-x64.dmg' },
            win: { url: 'https://example.com/KYROlll-MANAGER-Setup-1.0.0.exe' },
          },
          downloadPage: 'https://github.com/KYROllll/KYROlll-MANAGER/releases/latest',
        },
        plugins: [
          {
            id: 'kyrolll-soul',
            name: 'KYROlll SOUL',
            version: '1.4.0',
            formats: ['AU', 'VST3'],
            identifier: 'store.kyrolll.soul',
            downloads: {
              mac: { url: 'demo://kyrolll-soul' },
              win: { url: 'demo://kyrolll-soul' },
            },
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
  process.env.KYROLLL_RELEASE_FEED_URL = `${origin}/releases/latest`;

  const { app } = require('electron');
  app.setPath('userData', stateDir);
  app.setPath('downloads', downloadsDir);

  require('../src/main/main');

  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', async () => {
      try {
        let state = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          state = await win.webContents.executeJavaScript(`(() => {
            const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
            return {
              visible: !document.querySelector('#app-update').hidden,
              title: text('#app-update-title'),
              versions: text('#app-update-version-line'),
              notes: text('#app-update-notes'),
              action: text('#app-update-download'),
            };
          })()`);
          if (state.visible && state.versions) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        console.log('release banner', JSON.stringify(state));
        assert(state.visible, 'App update banner should be visible from the release feed');
        assert(state.versions.includes(releaseVersion), `Expected ${releaseVersion} in the version line, got ${state.versions}`);
        assert(state.title.includes(releaseVersion), `Expected ${releaseVersion} in the title, got ${state.title}`);
        assert(/installer handoff/i.test(state.notes), `Expected release notes from the feed, got ${state.notes}`);
        assert(state.action === 'Download Update (DMG)', `Unexpected download action: ${state.action}`);

        const snapshot = await win.webContents.executeJavaScript('window.kyrolll.getSnapshot()');
        assert(snapshot.appUpdateSource === 'feed', `Expected the release feed source, got ${snapshot.appUpdateSource}`);
        assert(snapshot.appUpdate?.latestVersion === releaseVersion, 'Snapshot latest version mismatch');

        await win.webContents.executeJavaScript("document.querySelector('#app-update-download').click()");

        for (let attempt = 0; attempt < 120; attempt += 1) {
          state = await win.webContents.executeJavaScript(`(() => {
            const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
            return {
              action: text('#app-update-download'),
              reveal: text('#app-update-reveal'),
              revealHidden: document.querySelector('#app-update-reveal').hidden,
              progress: text('#app-update-progress'),
            };
          })()`);
          if (state.action === 'Install Update') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        console.log('download state', JSON.stringify(state));
        assert(state.action === 'Install Update', `Expected "Install Update", got "${state.action}"`);
        assert(!state.revealHidden && state.reveal === 'Show Installer', 'Expected the "Show Installer" action');
        assert(/INSTALLER READY/i.test(state.progress), `Unexpected progress: ${state.progress}`);

        const file = path.join(downloadsDir, installerName);
        assert(fs.existsSync(file), `Installer was not downloaded to ${downloadsDir}`);
        assert(fs.readFileSync(file).length === installerBytes.length, 'Downloaded installer size mismatch');
        console.log('SMOKE APP RELEASE OK');
      } catch (err) {
        console.error('SMOKE APP RELEASE FAIL:', err.stack || err.message);
        process.exitCode = 1;
      } finally {
        server.close();
        app.quit();
      }
    });
  });
});
