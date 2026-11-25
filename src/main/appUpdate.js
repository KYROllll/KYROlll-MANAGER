'use strict';

const config = require('./config');
const catalog = require('./catalog');
const { compareVersions } = require('./plugins');
const { fetchText } = require('./net-fetch');

/**
 * App-level update check.
 *
 * The latest KYROlll desktop release can be described either by the public
 * catalog ("app": { latestVersion, downloads: { mac, win } }) or by a separate
 * release feed (a small JSON document or the GitHub releases/latest payload).
 * Both are optional: with no network the bundled catalog still supplies a
 * version, so the check simply reports "up to date".
 */

let state = {
  info: null,
  source: null,
  error: null,
  checkedAt: null,
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function notesFromBody(body) {
  if (typeof body !== 'string') return [];
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s]+/, '').trim())
    .filter((line) => line && !/^full changelog/i.test(line))
    .slice(0, 20);
}

/** Accept a compact feed or a GitHub releases/latest response. */
function normalizeReleaseFeed(raw) {
  if (!isPlainObject(raw)) return null;

  if (raw.latestVersion || raw.version) {
    return catalog.normalizeApp(raw);
  }

  if (!raw.tag_name && !raw.name) return null;

  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  const downloads = {};
  for (const asset of assets) {
    if (!asset || typeof asset.url !== 'string' && typeof asset.browser_download_url !== 'string') continue;
    const url = asset.browser_download_url || asset.url;
    const name = String(asset.name || url).toLowerCase();
    const entry = { url, size: Number.isFinite(asset.size) ? asset.size : null, sha256: null };
    if (/\.(dmg|pkg)$/.test(name)) {
      if (/arm64|aarch64/.test(name)) downloads.macArm64 = downloads.macArm64 || entry;
      else if (/x64|intel|amd64/.test(name)) downloads.macIntel = downloads.macIntel || entry;
      else downloads.mac = downloads.mac || entry;
    } else if (/\.(exe|msi)$/.test(name)) downloads.win = downloads.win || entry;
    else if (/\.appimage$/.test(name)) downloads.linux = downloads.linux || entry;
  }

  return catalog.normalizeApp({
    latestVersion: raw.tag_name || raw.name,
    releasedAt: raw.published_at || null,
    releaseNotes: notesFromBody(raw.body),
    downloads,
    downloadPage: raw.html_url || null,
  });
}

async function check(currentVersion) {
  let feed = null;
  let feedError = null;

  if (config.releaseFeedUrl) {
    try {
      const body = await fetchText(config.releaseFeedUrl, config.requestTimeoutMs, {
        Accept: 'application/vnd.github+json, application/json',
        'User-Agent': 'KYROlll-Hub',
      });
      feed = normalizeReleaseFeed(JSON.parse(body));
      if (!feed) feedError = 'Release feed did not contain a recognizable version.';
    } catch (err) {
      feedError = err.message || String(err);
    }
  }

  const catalogApp = catalog.getState()?.catalog?.app || null;
  let latest = feed;
  if (!latest || (catalogApp && compareVersions(catalogApp.latestVersion, latest.latestVersion) > 0)) {
    latest = catalogApp;
  }

  if (!latest) {
    state = {
      info: {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseNotes: [],
        downloadUrl: config.appDownloadPage || null,
        releaseUrl: config.appDownloadPage || null,
        downloads: {},
      },
      source: 'none',
      error: feedError,
      checkedAt: new Date().toISOString(),
    };
    return getState();
  }

  const download = catalog.appDownloadFor(latest.downloads);
  const releaseUrl = latest.downloadPage || config.appDownloadPage || null;

  state = {
    info: {
      currentVersion,
      latestVersion: latest.latestVersion,
      updateAvailable: compareVersions(latest.latestVersion, currentVersion) > 0,
      releasedAt: latest.releasedAt || null,
      releaseNotes: latest.releaseNotes || [],
      downloadUrl: download?.url || releaseUrl,
      releaseUrl,
      size: download?.size || null,
      downloads: latest.downloads || {},
    },
    source: latest === feed ? 'feed' : latest === catalogApp ? 'catalog' : 'none',
    error: feedError,
    checkedAt: new Date().toISOString(),
  };
  return getState();
}

function getState() {
  return {
    ...state,
    releaseFeedUrl: config.releaseFeedUrl || null,
  };
}

module.exports = { check, getState, normalizeReleaseFeed };
