'use strict';

/**
 * Remote plug-in package smoke test.
 *
 * Serves the real KYROlll SOUL 1.4.0 macOS archive over local HTTP and points
 * the catalog's primary download at it. This is the path an already-installed
 * KYROlll MANAGER uses when a new version is published in catalog.json: it
 * downloads the versioned package from the repository, verifies the checksum
 * and installs it without needing a new app build.
 *
 * Usage: npm run smoke:plugin-remote
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const root = path.join(os.tmpdir(), 'kyrolll-plugin-remote-smoke');
const stateDir = path.join(root, 'state');
const auDir = path.join(root, 'au');
const vstDir = path.join(root, 'vst3');
const catalogPath = path.join(root, 'catalog.json');
const archive = path.join(ROOT, 'resources', 'plugins', 'kyrolll-soul-1.4.0-mac.zip');

fs.rmSync(root, { recursive: true, force: true });
for (const dir of [stateDir, auDir, vstDir]) fs.mkdirSync(dir, { recursive: true });

const archiveBytes = fs.readFileSync(archive);
const sha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');
const archiveName = path.basename(archive);

let origin = '';
const server = http.createServer((req, res) => {
  if (req.url === `/${archiveName}`) {
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': archiveBytes.length,
    });
    res.end(archiveBytes);
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
        app: { latestVersion: '1.0.0' },
        plugins: [
          {
            id: 'kyrolll-soul',
            name: 'KYROlll SOUL',
            version: '1.4.0',
            tagline: 'Analog soul, tape-worn and alive.',
            description: 'Remote package smoke entry.',
            identifier: 'store.kyrolll.soul',
            formats: ['AU', 'VST3'],
            size: archiveBytes.length,
            downloads: {
              mac: {
                url: `${origin}/${archiveName}`,
                fallbackUrl: `app://plugins/${archiveName}`,
                sha256,
                size: archiveBytes.length,
              },
              win: {
                url: `${origin}/kyrolll-soul-1.4.0-win.zip`,
                fallbackUrl: 'app://plugins/kyrolll-soul-1.4.0-win.zip',
              },
            },
            releaseNotes: ['Remote package smoke note'],
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
  app.whenReady().then(async () => {
    try {
      const catalog = require('../src/main/catalog');
      const installer = require('../src/main/installer');
      const installedState = require('../src/main/installedState');
      const plugins = require('../src/main/plugins');

      await catalog.init();
      await catalog.refresh();
      const plugin = catalog.findPlugin('kyrolll-soul');
      assert(plugin?.version === '1.4.0', `Expected catalog 1.4.0, got ${plugin?.version}`);
      assert(catalog.downloadFor(plugin)?.url === `${origin}/${archiveName}`, 'Primary download URL missing');

      const progress = [];
      const record = await installer.runInstall({
        plugin,
        onProgress: (payload) => progress.push(payload),
      });

      const downloadEvents = progress.filter((event) => event.phase === 'downloading');
      const extractEvents = progress.filter((event) => event.phase === 'extracting');
      const installEvents = progress.filter((event) => event.phase === 'installing');
      console.log(
        'progress',
        JSON.stringify({
          download: downloadEvents.map((event) => event.detail),
          extract: extractEvents.map((event) => event.detail),
          install: installEvents.map((event) => event.detail),
        })
      );

      assert(record.sourceUrl === `${origin}/${archiveName}`, `Expected the HTTP source, got ${record.sourceUrl}`);
      assert(
        downloadEvents.some((event) => /\d+\s*(KB|MB)/i.test(event.detail || '')),
        `Download progress did not report bytes: ${downloadEvents.map((event) => event.detail)}`
      );
      assert(
        extractEvents.some((event) => /Extracted \d+ files/i.test(event.detail || '')),
        `Extract progress did not report files: ${extractEvents.map((event) => event.detail)}`
      );
      assert(
        installEvents.some((event) => /Placed .*\.component|Placed .*\.vst3/i.test(event.detail || '')),
        `Install progress did not report placed bundles: ${installEvents.map((event) => event.detail)}`
      );

      const bundles = await plugins.scan();
      assert(bundles.length === 2, `Expected 2 bundles on disk, got ${bundles.length}`);
      assert(bundles.every((bundle) => bundle.version === '1.4.0'), 'Bundles on disk are not 1.4.0');
      const state = await installedState.read();
      assert(state.plugins['kyrolll-soul']?.sourceUrl === `${origin}/${archiveName}`, 'installed.json source mismatch');
      console.log('SMOKE PLUGIN REMOTE OK');
    } catch (err) {
      console.error('SMOKE PLUGIN REMOTE FAIL:', err.stack || err.message);
      process.exitCode = 1;
    } finally {
      server.close();
      app.quit();
    }
  });
});
