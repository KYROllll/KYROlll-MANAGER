'use strict';

/**
 * Static build/configuration checks that can run on any host without
 * packaging anything. Verifies the electron-builder Windows + macOS targets,
 * the bundled resources, and the cross-platform plug-in path logic.
 *
 * Usage: npm run verify:build
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readPng } = require('./lib/png');

const ROOT = path.join(__dirname, '..');
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build || {};

console.log('electron-builder targets');
check('appId is set', Boolean(build.appId));
check('productName is KYROlll MANAGER', build.productName === 'KYROlll MANAGER');
check('main entry exists', Boolean(pkg.main) && fs.existsSync(path.join(ROOT, pkg.main)), pkg.main);
check('mac target is DMG only', Array.isArray(build.mac?.target) && build.mac.target.length === 1 && build.mac.target[0] === 'dmg');
check('mac artifact names include architecture', String(build.mac?.artifactName || '').includes('${arch}'));
check('mac script builds arm64 and x64', /--arm64/.test(pkg.scripts?.['dist:mac'] || '') && /--x64/.test(pkg.scripts?.['dist:mac'] || ''));
check('Windows target is NSIS only', Array.isArray(build.win?.target) && build.win.target.length === 1 && build.win.target[0].target === 'nsis');
check('Windows targets publish x64', build.win?.target?.every((t) => !t.arch || t.arch.includes('x64')));
check(
  'no app ZIP targets are configured',
  !(build.mac?.target || []).includes('zip') && !(build.win?.target || []).some((t) => t.target === 'zip')
);
check('nsis allows install directory choice', build.nsis?.allowToChangeInstallationDirectory === true);
check('icon exists', fs.existsSync(path.join(ROOT, build.mac?.icon || 'build/icon.png')));
check('DMG background configured', Boolean(build.dmg?.background));
check(
  'DMG background file exists',
  Boolean(build.dmg?.background) && fs.existsSync(path.join(ROOT, build.dmg.background)),
  build.dmg?.background
);
check(
  'DMG contents place app and Applications link',
  Array.isArray(build.dmg?.contents) &&
    build.dmg.contents.some((item) => item.type === 'file') &&
    build.dmg.contents.some((item) => item.type === 'link' && item.path === '/Applications')
);

console.log('DMG design');
const dmgWindow = build.dmg?.window || {};
const dmgContents = build.dmg?.contents || [];
const appSlot = dmgContents.find((item) => item.type === 'file') || {};
const applicationsSlot = dmgContents.find((item) => item.type === 'link') || {};
check('DMG window is 660x420', dmgWindow.width === 660 && dmgWindow.height === 420);
check('DMG icon size is 128', build.dmg?.iconSize === 128);
check('DMG app icon sits at (180, 200)', appSlot.x === 180 && appSlot.y === 200);
check('DMG Applications link sits at (480, 200)', applicationsSlot.x === 480 && applicationsSlot.y === 200);

const backgroundPath = build.dmg?.background ? path.join(ROOT, build.dmg.background) : null;
const retinaPath = backgroundPath ? backgroundPath.replace(/\.png$/i, '@2x.png') : null;
const background = backgroundPath && fs.existsSync(backgroundPath) ? readPng(backgroundPath) : null;
const retina = retinaPath && fs.existsSync(retinaPath) ? readPng(retinaPath) : null;

check('DMG background is 660x420', Boolean(background) && background.width === 660 && background.height === 420, background && `${background.width}x${background.height}`);
check('DMG Retina background exists at 1320x840', Boolean(retina) && retina.width === 1320 && retina.height === 840, retina && `${retina.width}x${retina.height}`);

if (background) {
  const corners = [
    ['top-left', 2, 2],
    ['top-right', background.width - 3, 2],
    ['bottom-left', 2, background.height - 3],
    ['bottom-right', background.width - 3, background.height - 3],
    ['centre', Math.round(background.width / 2), Math.round(background.height / 2)],
  ];
  const lightCorners = corners.filter(([, x, y]) => background.pixel(x, y).reduce((a, b) => a + b, 0) > 6);
  check('DMG plate is pure black around the edges and centre', lightCorners.length === 0, lightCorners.map((c) => c[0]).join(', '));

  function countPixels(x0, x1, y0, y1, threshold) {
    let count = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (background.pixel(x, y).reduce((a, b) => a + b, 0) >= threshold) count += 1;
      }
    }
    return count;
  }

  check('DMG wordmark is drawn in the upper area', countPixels(200, 460, 50, 108, 400) > 200);
  check('DMG white dotted arrow spans the icon gap', countPixels(258, 406, 184, 218, 600) > 60);
  check('DMG caption is drawn at the bottom', countPixels(150, 510, 368, 396, 90) > 200);
}
check('fallback catalog exists', fs.existsSync(path.join(ROOT, 'resources', 'catalog.fallback.json')));
check('app-managed plug-in package directory exists', fs.existsSync(path.join(ROOT, 'resources', 'plugins')));

console.log('cross-platform paths');
const { pluginDirsFor, platformInfo } = require('../src/main/paths');
const winPaths = pluginDirsFor('win32');
const macPaths = pluginDirsFor('darwin');
const expectedWinVst3 = path.win32.join(
  process.env.CommonProgramFiles || process.env['CommonProgramFiles(x86)'] || 'C:\\Program Files\\Common Files',
  'VST3'
);
check('Windows exposes only VST3', platformInfo('win32').formats.join(',') === 'VST3');
check('macOS exposes AU + VST3', platformInfo('darwin').formats.join(',') === 'AU,VST3');
check('Windows VST3 path', winPaths.VST3 === expectedWinVst3, winPaths.VST3);
check('Windows has no AU path', winPaths.AU === undefined);
check('macOS AU path intact', /Library[\\/]Audio[\\/]Plug-Ins[\\/]Components$/.test(macPaths.AU || ''), macPaths.AU);
check('macOS VST3 path intact', /Library[\\/]Audio[\\/]Plug-Ins[\\/]VST3$/.test(macPaths.VST3 || ''), macPaths.VST3);

console.log('catalog schema');
const catalog = require('../src/main/catalog');
const { compareVersions } = require('../src/main/plugins');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'catalog.fallback.json'), 'utf8'));
const normalized = catalog.normalizeCatalog(raw);
const repositoryCatalogPath = path.join(ROOT, 'catalog.json');
const repositoryRaw = fs.existsSync(repositoryCatalogPath)
  ? JSON.parse(fs.readFileSync(repositoryCatalogPath, 'utf8'))
  : null;
const repositoryNormalized = repositoryRaw ? catalog.normalizeCatalog(repositoryRaw) : null;
check('fallback catalog normalizes', normalized.plugins.length > 0);
check(
  'fallback app has three clean targets',
  Boolean(normalized.app?.downloads.macArm64?.url) &&
    Boolean(normalized.app?.downloads.macIntel?.url) &&
    Boolean(normalized.app?.downloads.win?.url) &&
    Object.keys(normalized.app?.downloads || {}).length === 3
);
check('plugin has macOS app-managed package', Boolean(normalized.plugins[0].downloads.mac?.url));
check('plugin has Windows app-managed package', Boolean(normalized.plugins[0].downloads.win?.url));
check(
  'fallback plug-in downloads keep a bundled package fallback',
  Object.values(normalized.plugins[0].downloads || {}).every((download) => download.fallbackUrl?.startsWith('app://plugins/'))
);
check('plugin has checksum + size', Boolean(normalized.plugins[0].downloads.mac?.sha256) && normalized.plugins[0].downloads.mac.size > 0);
check('plugin changelog present', normalized.plugins[0].releaseNotes.length > 0);
check('app release metadata present', Boolean(normalized.app?.latestVersion), JSON.stringify(normalized.app));
check('version comparison detects updates', compareVersions('1.3.0', '1.2.0') > 0);

console.log('repository catalog');
const releaseRoot = 'https://github.com/KYROllll/KYROlll-MANAGER/releases/latest/download/';
const plugin = repositoryNormalized?.plugins?.[0];
check('catalog.json exists at repo root', Boolean(repositoryNormalized));
const appDownloads = repositoryNormalized?.app?.downloads || {};
check('catalog app has Apple Silicon download', Boolean(appDownloads.macArm64?.url));
check('catalog app has Intel download', Boolean(appDownloads.macIntel?.url));
check('catalog app has Windows download', Boolean(appDownloads.win?.url));
check('catalog app has exactly three downloads', Object.keys(appDownloads).length === 3, Object.keys(appDownloads).join(','));
check(
  'app downloads target repository release assets',
  Object.values(appDownloads).every((download) => download.url.startsWith(releaseRoot))
);
check(
  'app downloads are installer files, not ZIPs',
  Object.values(appDownloads).every((download) => !/\.zip$/i.test(download.url))
);
check(
  'app download resolver selects Apple Silicon',
  /arm64/i.test(catalog.appDownloadFor(appDownloads, 'darwin', 'arm64')?.url || '')
);
check(
  'app download resolver selects Intel',
  /x64/i.test(catalog.appDownloadFor(appDownloads, 'darwin', 'x64')?.url || '')
);
check('KYROlll SOUL is in repository catalog', plugin?.id === 'kyrolll-soul');
check('SOUL has macOS + Windows app-managed packages', Boolean(plugin?.downloads.mac?.url) && Boolean(plugin?.downloads.win?.url));
const repositoryPackageRoot =
  'https://raw.githubusercontent.com/KYROllll/KYROlll-MANAGER/main/resources/plugins/';
check(
  'SOUL primary downloads are versioned repository packages',
  Object.values(plugin?.downloads || {}).every(
    (download) =>
      download.url.startsWith(repositoryPackageRoot) &&
      path.basename(download.url).includes(plugin.version)
  )
);
check(
  'SOUL downloads keep an app-managed fallback',
  Object.values(plugin?.downloads || {}).every((download) => download.fallbackUrl?.startsWith('app://plugins/'))
);
check(
  'SOUL primary and fallback packages share a filename',
  Object.values(plugin?.downloads || {}).every(
    (download) => path.basename(download.url) === path.basename(download.fallbackUrl || '')
  )
);
check(
  'SOUL checksum and size fields are explicit',
  Object.values(plugin?.downloads || {}).every((download) => 'sha256' in download && 'size' in download)
);

const appManagedDownloads = Object.values(plugin?.downloads || {}).filter((download) =>
  download.fallbackUrl?.startsWith('app://plugins/')
);
const appManagedFiles = appManagedDownloads.map((download) =>
  path.join(ROOT, 'resources', 'plugins', download.fallbackUrl.replace('app://plugins/', ''))
);
check('SOUL app-managed packages are bundled', appManagedFiles.length > 0 && appManagedFiles.every((file) => fs.existsSync(file)));
check(
  'SOUL app-managed package sizes match the catalog',
  appManagedDownloads.every((download, index) => fs.statSync(appManagedFiles[index]).size === download.size)
);
check(
  'SOUL app-managed package checksums match the catalog',
  appManagedDownloads.every((download, index) =>
    crypto.createHash('sha256').update(fs.readFileSync(appManagedFiles[index])).digest('hex') === download.sha256
  )
);

if (failures.length) {
  console.error(`\n${failures.length} build configuration check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nBUILD CONFIG OK');
}
