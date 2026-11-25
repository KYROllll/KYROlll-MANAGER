'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pluginDirs, supportedFormats, platformKey } = require('./paths');

/**
 * Cross-platform plug-in detection.
 *
 * macOS  : AU (.component) and VST3 (.vst3) are bundle folders containing
 *          Contents/Info.plist.
 * Windows: VST3 (.vst3) is a bundle folder containing the Windows binary;
 *          version metadata comes from Contents/Info.plist when present or
 *          Contents/moduleinfo.json otherwise.
 *
 * A missing plug-in folder simply yields no bundles, so a fresh machine or
 * a machine without the VST3 system folder never errors.
 */

const FORMAT_BY_EXTENSION = {
  '.component': 'AU',
  '.vst3': 'VST3',
};

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function readPlistValue(plist, key) {
  const match = plist.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`, 'i'));
  return match ? match[1].trim() : null;
}

function readModuleInfoValue(info, key) {
  if (!info || typeof info !== 'object') return null;
  const value = info[key] ?? info[key.toLowerCase()];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function inspectBundle(bundlePath) {
  const name = path.basename(bundlePath);
  const extension = path.extname(name).toLowerCase();
  const format = FORMAT_BY_EXTENSION[extension];
  if (!format) return null;

  let version = null;
  let identifier = null;
  let displayName = name.replace(/\.(component|vst3)$/i, '');

  try {
    const plist = await fs.readFile(path.join(bundlePath, 'Contents', 'Info.plist'), 'utf8');
    version = readPlistValue(plist, 'CFBundleShortVersionString');
    identifier = readPlistValue(plist, 'CFBundleIdentifier');
    displayName = readPlistValue(plist, 'CFBundleName') || displayName;
  } catch {
    // Windows VST3 bundles often ship no Info.plist; try moduleinfo.json.
  }

  if (!version || !identifier) {
    try {
      const moduleInfo = JSON.parse(await fs.readFile(path.join(bundlePath, 'Contents', 'moduleinfo.json'), 'utf8'));
      version = version || readModuleInfoValue(moduleInfo, 'Version') || readModuleInfoValue(moduleInfo, 'version');
      identifier = identifier || readModuleInfoValue(moduleInfo, 'BundleId') || readModuleInfoValue(moduleInfo, 'cid');
      displayName = readModuleInfoValue(moduleInfo, 'Name') || displayName;
    } catch {
      // Bundle without readable metadata is still a real installation.
    }
  }

  return { format, path: bundlePath, name, displayName, identifier, version };
}

/** Scan the platform's plug-in folders. Missing folders yield no bundles. */
async function scan(extraDirs = {}, platform = process.platform) {
  const dirs = { ...pluginDirs, ...extraDirs };
  const formats = new Set(supportedFormats(platform));
  const results = [];

  await Promise.all(
    Object.entries(dirs).map(async ([format, dir]) => {
      if (!dir || !formats.has(format)) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const entryFormat = FORMAT_BY_EXTENSION[path.extname(entry.name).toLowerCase()];
        if (!entryFormat || entryFormat !== format) continue;
        const info = await inspectBundle(path.join(dir, entry.name));
        if (info) results.push(info);
      }
    })
  );

  return results;
}

function parseVersion(version) {
  const [core, ...rest] = String(version || '').trim().replace(/^v/i, '').split('-');
  const numbers = core.split('.').map((part) => {
    const n = parseInt(part.replace(/[^0-9].*$/, ''), 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (numbers.length < 3) numbers.push(0);
  return { numbers, prerelease: rest.join('-') };
}

/** Returns 1 if a > b, -1 if a < b, 0 if equal. */
function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < Math.max(va.numbers.length, vb.numbers.length); i += 1) {
    const diff = (va.numbers[i] || 0) - (vb.numbers[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (va.prerelease === vb.prerelease) return 0;
  if (!va.prerelease) return 1;
  if (!vb.prerelease) return -1;
  return va.prerelease > vb.prerelease ? 1 : -1;
}

function bundleBelongsToPlugin(bundle, plugin) {
  if (bundle.identifier && plugin.identifier) {
    if (bundle.identifier === plugin.identifier) return true;
    if (bundle.identifier.startsWith(`${plugin.identifier}.`)) return true;
  }
  const bundleName = normalizeName(bundle.displayName || bundle.name);
  const pluginName = normalizeName(plugin.name);
  return Boolean(bundleName && pluginName && bundleName === pluginName);
}

/**
 * Merge catalog + installed.json + filesystem scan into one view model.
 * Status is always derived from what is actually on disk, so deleting a
 * bundle by hand immediately flips the app back to "Not Installed".
 */
function buildPluginViews({ catalog, state, bundles, platform = process.platform }) {
  const records = (state && state.plugins) || {};
  const claimed = new Set();
  const platformFormats = supportedFormats(platform);
  const platformId = platformKey(platform);

  const views = (catalog ? catalog.plugins : []).map((plugin) => {
    const matches = bundles.filter((bundle) => bundleBelongsToPlugin(bundle, plugin));
    matches.forEach((bundle) => claimed.add(bundle.path));

    const record = records[plugin.id] || null;
    const formatsInstalled = [...new Set(matches.map((bundle) => bundle.format))];
    const detectedVersion = matches.map((bundle) => bundle.version).filter(Boolean).sort(compareVersions).pop() || null;
    // Prefer the version actually on disk; fall back to the install record for
    // bundles that do not expose version metadata (some Windows VST3 builds).
    const installedVersion = detectedVersion || (record && record.version ? record.version : null);

    // On Windows only VST3 exists in the catalog view, so AU never appears
    // as a permanently "missing" format.
    const formats = (plugin.formats || []).filter((format) => platformFormats.includes(format));
    const availableFormats = formats.length ? formats : platformFormats;

    let status = 'not-installed';
    if (matches.length > 0) {
      status = installedVersion && compareVersions(plugin.version, installedVersion) > 0 ? 'update-available' : 'installed';
    }

    const platformDownload = plugin.downloads ? plugin.downloads[platformId] || null : null;

    return {
      ...plugin,
      formats: availableFormats,
      allFormats: plugin.formats || [],
      platformDownload,
      status,
      installedVersion,
      updateFrom: status === 'update-available' ? installedVersion : null,
      updateTo: status === 'update-available' ? plugin.version : null,
      installedAt: record ? record.installedAt || null : null,
      detectedPaths: matches.map((bundle) => ({ format: bundle.format, path: bundle.path })),
      formatsInstalled,
      missingFormats: availableFormats.filter((format) => !formatsInstalled.includes(format)),
    };
  });

  // Bundles that exist but do not match any catalog entry: surfaced as an
  // informational count only, never as installable plugins.
  const untracked = bundles.filter((bundle) => !claimed.has(bundle.path));

  return { views, untracked };
}

module.exports = { scan, buildPluginViews, compareVersions, inspectBundle, bundleBelongsToPlugin };
