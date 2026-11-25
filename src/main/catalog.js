'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { catalogCacheFile, platformKey } = require('./paths');
const { fetchText } = require('./net-fetch');

/**
 * Catalog loading has three tiers, in priority order:
 *   1. remote JSON (config.catalogUrl)
 *   2. last known good copy cached in userData
 *   3. bundled resources/catalog.fallback.json
 * The app therefore always has a catalog to render, even fully offline.
 *
 * A catalog entry may provide one shared version plus per-platform downloads:
 *
 *   "downloads": {
 *     "macArm64": { "url": "...", "sha256": "...", "size": 48261120 },
 *     "macIntel": { "url": "...", "sha256": "...", "size": 49261120 },
 *     "win": { "url": "...", "sha256": "...", "size": 51234567 }
 *   }
 *
 * Plug-in downloads use the platform keys mac/win/linux. App downloads may
 * additionally use macArm64/macIntel so an Apple Silicon app never downloads
 * an Intel installer (or vice versa). The legacy single "download" object
 * still works and is treated as the macOS/default archive.
 */

const PLATFORMS = ['mac', 'win', 'linux'];
const APP_ARCH_PLATFORMS = ['macArm64', 'macIntel'];
const DOWNLOAD_PLATFORMS = [...PLATFORMS, ...APP_ARCH_PLATFORMS];

let state = {
  catalog: null,
  source: 'fallback',
  error: null,
  lastCheckedAt: null,
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDownload(raw) {
  if (typeof raw === 'string') return { url: raw.trim(), sha256: null, size: null, version: null };
  if (!isPlainObject(raw)) return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) return null;
  return {
    url,
    sha256: typeof raw.sha256 === 'string' && raw.sha256.trim() ? raw.sha256.trim().toLowerCase() : null,
    size: Number.isFinite(raw.size) && raw.size > 0 ? raw.size : null,
    version: typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null,
  };
}

function normalizeDownloads(raw) {
  const source = isPlainObject(raw.downloads) ? raw.downloads : {};
  const downloads = {};

  for (const platform of DOWNLOAD_PLATFORMS) {
    const entry =
      source[platform] ??
      source[platform === 'mac' ? 'macos' : platform === 'win' ? 'windows' : platform];
    const normalized = normalizeDownload(entry);
    if (normalized) downloads[platform] = normalized;
  }

  // Legacy single download (and downloadUrl) is the macOS/default archive.
  if (!downloads.mac) {
    const legacy = normalizeDownload(raw.download) || normalizeDownload(raw.downloadUrl);
    if (legacy) downloads.mac = legacy;
  }
  // A legacy-only catalog is still useful on Windows when the same archive
  // happens to be cross-platform; expose it as a last resort.
  if (!downloads.win && downloads.mac && raw.crossPlatform !== false && !source.win) {
    downloads.win = { ...downloads.mac };
  }

  return downloads;
}

function downloadFor(plugin, platform = platformKey()) {
  if (!plugin) return null;
  const downloads = plugin.downloads || {};
  return downloads[platform] || null;
}

/** Resolve an app download for this OS and CPU architecture. */
function appDownloadFor(downloads, platform = process.platform, arch = process.arch) {
  if (!isPlainObject(downloads)) return null;
  const key = platformKey(platform);
  if (key === 'mac') {
    const archKey = arch === 'arm64' ? 'macArm64' : 'macIntel';
    return downloads[archKey] || downloads.mac || null;
  }
  return downloads[key] || null;
}

function normalizeReleaseNotes(raw) {
  const notes = Array.isArray(raw.releaseNotes)
    ? raw.releaseNotes
    : Array.isArray(raw.changelog)
      ? raw.changelog
      : Array.isArray(raw.changes)
        ? raw.changes
        : [];
  return notes.map((line) => String(line)).filter(Boolean);
}

function normalizePlugin(raw, index) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!id || !name || !version) return null;

  const downloads = normalizeDownloads(raw);
  const resolved = downloadFor({ downloads });

  const formats = Array.isArray(raw.formats)
    ? raw.formats.map((f) => String(f).toUpperCase()).filter((f) => f === 'AU' || f === 'VST3')
    : ['AU', 'VST3'];

  const releaseNotes = normalizeReleaseNotes(raw);

  return {
    id,
    name,
    version,
    tagline: typeof raw.tagline === 'string' ? raw.tagline : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    identifier: typeof raw.identifier === 'string' && raw.identifier.trim() ? raw.identifier.trim() : `store.kyrolll.${id}`,
    formats: formats.length ? formats : ['AU', 'VST3'],
    featured: Boolean(raw.featured),
    releasedAt: typeof raw.releasedAt === 'string' ? raw.releasedAt : null,
    size: Number.isFinite(raw.size) ? raw.size : resolved?.size || null,
    releaseNotes,
    // "changelog" is the same data under the name used by update UIs.
    changelog: releaseNotes,
    image: typeof raw.image === 'string' && raw.image.trim() ? raw.image.trim() : null,
    downloads,
    download: resolved,
    order: Number.isFinite(raw.order) ? raw.order : index,
  };
}

function normalizeApp(raw) {
  if (!isPlainObject(raw)) return null;
  const version =
    (typeof raw.latestVersion === 'string' && raw.latestVersion.trim()) ||
    (typeof raw.version === 'string' && raw.version.trim()) ||
    (typeof raw.tag_name === 'string' && raw.tag_name.trim()) ||
    null;
  if (!version) return null;

  const downloads = normalizeDownloads(raw);
  const releaseNotes = normalizeReleaseNotes(raw);
  return {
    latestVersion: version.replace(/^v/i, ''),
    releasedAt: typeof raw.releasedAt === 'string' ? raw.releasedAt : typeof raw.published_at === 'string' ? raw.published_at : null,
    releaseNotes,
    changelog: releaseNotes,
    downloads,
    downloadPage:
      (typeof raw.downloadPage === 'string' && raw.downloadPage.trim()) ||
      (typeof raw.html_url === 'string' && raw.html_url.trim()) ||
      (typeof raw.releaseUrl === 'string' && raw.releaseUrl.trim()) ||
      null,
  };
}

function normalizeCatalog(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.plugins)) {
    throw new Error('Catalog must be an object with a "plugins" array.');
  }
  const plugins = raw.plugins
    .map((entry, index) => normalizePlugin(entry, index))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);

  if (!plugins.length) throw new Error('Catalog contains no valid plugins.');

  const seen = new Set();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) throw new Error(`Duplicate plugin id "${plugin.id}" in catalog.`);
    seen.add(plugin.id);
  }

  return {
    schemaVersion: Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    channel: typeof raw.channel === 'string' ? raw.channel : 'stable',
    app: normalizeApp(raw.app || raw.release || raw.latestRelease),
    plugins,
  };
}

async function writeCache(rawCatalog) {
  try {
    const payload = JSON.stringify({ cachedAt: new Date().toISOString(), catalog: rawCatalog }, null, 2);
    await fs.mkdir(path.dirname(catalogCacheFile()), { recursive: true });
    await fs.writeFile(catalogCacheFile(), payload, 'utf8');
  } catch {
    // Cache is best-effort; never block a successful fetch on it.
  }
}

async function loadFallback() {
  const raw = await fs.readFile(config.fallbackCatalogFile, 'utf8');
  return normalizeCatalog(JSON.parse(raw));
}

/** Load whichever catalog is available without touching the network. */
async function init() {
  try {
    const cached = JSON.parse(await fs.readFile(catalogCacheFile(), 'utf8'));
    state.catalog = normalizeCatalog(cached.catalog);
    state.source = 'cache';
    state.lastCheckedAt = cached.cachedAt || null;
    return getState();
  } catch {
    // fall through to bundled fallback
  }
  try {
    state.catalog = await loadFallback();
    state.source = 'fallback';
  } catch (err) {
    state.catalog = { schemaVersion: 1, updatedAt: null, channel: 'stable', app: null, plugins: [] };
    state.source = 'fallback';
    state.error = `Bundled catalog could not be read: ${err.message}`;
  }
  return getState();
}

/** Fetch the live catalog. Keeps the previous catalog if the fetch fails. */
async function refresh() {
  if (!config.catalogUrl) {
    if (!state.catalog) await init();
    state.error = null;
    return getState();
  }
  try {
    const body = await fetchText(config.catalogUrl, config.requestTimeoutMs, {
      Accept: 'application/json',
      'User-Agent': 'KYROlll-Hub',
    });
    const parsed = JSON.parse(body);
    const catalog = normalizeCatalog(parsed);
    state.catalog = catalog;
    state.source = 'remote';
    state.error = null;
    state.lastCheckedAt = new Date().toISOString();
    await writeCache(parsed);
  } catch (err) {
    state.error = err.message || String(err);
    if (!state.catalog) await init();
  }
  return getState();
}

function getState() {
  return {
    catalog: state.catalog,
    source: state.source,
    error: state.error,
    lastCheckedAt: state.lastCheckedAt,
    catalogUrl: config.catalogUrl || null,
  };
}

function findPlugin(pluginId) {
  return state.catalog ? state.catalog.plugins.find((entry) => entry.id === pluginId) || null : null;
}

module.exports = {
  init,
  refresh,
  getState,
  findPlugin,
  normalizeCatalog,
  normalizePlugin,
  normalizeApp,
  downloadFor,
  appDownloadFor,
};
