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
check('productName is KYROlll', build.productName === 'KYROlll');
check('main entry exists', Boolean(pkg.main) && fs.existsSync(path.join(ROOT, pkg.main)), pkg.main);
check('mac target includes dmg', Array.isArray(build.mac?.target) && build.mac.target.includes('dmg'));
check('Windows target includes nsis', Array.isArray(build.win?.target) && build.win.target.some((t) => t.target === 'nsis'));
check('Windows target includes zip', Array.isArray(build.win?.target) && build.win.target.some((t) => t.target === 'zip'));
check('Windows targets publish x64', build.win?.target?.every((t) => !t.arch || t.arch.includes('x64')));
check('nsis allows install directory choice', build.nsis?.allowToChangeInstallationDirectory === true);
check('icon exists', fs.existsSync(path.join(ROOT, build.mac?.icon || 'build/icon.png')));
check('fallback catalog exists', fs.existsSync(path.join(ROOT, 'resources', 'catalog.fallback.json')));
check('demo archive exists', fs.existsSync(path.join(ROOT, 'resources', 'demo', 'kyrolll-soul.zip')));

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
check('plugin has macOS download', Boolean(normalized.plugins[0].downloads.mac?.url));
check('plugin has Windows download', Boolean(normalized.plugins[0].downloads.win?.url));
check('plugin has checksum + size', Boolean(normalized.plugins[0].downloads.mac?.sha256) && normalized.plugins[0].downloads.mac.size > 0);
check('plugin changelog present', normalized.plugins[0].releaseNotes.length > 0);
check('app release metadata present', Boolean(normalized.app?.latestVersion), JSON.stringify(normalized.app));
check('version comparison detects updates', compareVersions('1.3.0', '1.2.0') > 0);

console.log('repository catalog');
const releaseRoot = 'https://github.com/KYROllll/KYROlll-MANAGER/releases/latest/download/';
const plugin = repositoryNormalized?.plugins?.[0];
check('catalog.json exists at repo root', Boolean(repositoryNormalized));
check('catalog app has macOS download', Boolean(repositoryNormalized?.app?.downloads.mac?.url));
check('catalog app has Windows download', Boolean(repositoryNormalized?.app?.downloads.win?.url));
check(
  'app downloads target repository release assets',
  Object.values(repositoryNormalized?.app?.downloads || {}).every((download) => download.url.startsWith(releaseRoot))
);
check('KYROlll SOUL is in repository catalog', plugin?.id === 'kyrolll-soul');
check('SOUL has macOS + Windows release downloads', Boolean(plugin?.downloads.mac?.url) && Boolean(plugin?.downloads.win?.url));
check(
  'SOUL downloads target repository release assets',
  Object.values(plugin?.downloads || {}).every((download) => download.url.startsWith(releaseRoot))
);
check(
  'SOUL checksum and size fields are explicit',
  Object.values(plugin?.downloads || {}).every((download) => 'sha256' in download && 'size' in download)
);

if (failures.length) {
  console.error(`\n${failures.length} build configuration check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nBUILD CONFIG OK');
}
