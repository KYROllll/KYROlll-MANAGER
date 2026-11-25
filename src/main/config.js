'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resourcesDir, configFile } = require('./paths');

/**
 * Configuration is resolved from three layers, highest priority first:
 *   1. environment variables (KYROLLL_*)
 *   2. config.json in the app userData folder (or KYROLLL_CONFIG_FILE)
 *   3. built-in defaults (bundled catalog, offline-first)
 *
 * The app defaults to the catalog in the KYROlll GitHub repository. The
 * bundled catalog remains complete, so a missing network or an unavailable
 * raw URL still opens cleanly offline. Override KYROLLL_CATALOG_URL /
 * "catalogUrl" to point at another live catalog.json.
 */

const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/KYROllll/KYROlll-MANAGER/main/catalog.json';

// The published GitHub release is the authoritative app version. The catalog
// stays as a fallback for offline/cached starts and for hosts that mirror the
// release metadata elsewhere.
const DEFAULT_RELEASE_FEED_URL =
  'https://api.github.com/repos/KYROllll/KYROlll-MANAGER/releases/latest';

function readUserConfig() {
  const file = configFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

const userConfig = readUserConfig();

function envString(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function configString(key, envName) {
  const fromEnv = envString(envName);
  if (fromEnv) return fromEnv;
  const value = userConfig[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function configNumber(key, envName, fallback) {
  const fromEnv = Number(envString(envName));
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const value = Number(userConfig[key]);
  if (Number.isFinite(value) && value > 0) return value;
  return fallback;
}

const FEED_DISABLED = /^(off|none|disabled|false)$/i;

/**
 * The release feed defaults to the live GitHub release. Tests and offline
 * installs disable it with KYROLLL_RELEASE_FEED_URL=off instead of silently
 * inheriting the network default.
 */
function resolveReleaseFeedUrl() {
  const fromEnv = envString('KYROLLL_RELEASE_FEED_URL');
  const fromConfig =
    typeof userConfig.releaseFeedUrl === 'string' ? userConfig.releaseFeedUrl.trim() : '';
  const raw = fromEnv ?? fromConfig;
  if (raw && FEED_DISABLED.test(raw)) return '';
  return raw || DEFAULT_RELEASE_FEED_URL;
}

function configBoolean(key, envName, fallback) {
  const fromEnv = envString(envName);
  if (fromEnv) return !/^(0|false|no|off)$/i.test(fromEnv);
  if (typeof userConfig[key] === 'boolean') return userConfig[key];
  return fallback;
}

module.exports = {
  appName: 'KYROlll MANAGER',
  catalogUrl: configString('catalogUrl', 'KYROLLL_CATALOG_URL') || DEFAULT_CATALOG_URL,
  releaseFeedUrl: resolveReleaseFeedUrl(),
  appDownloadPage: configString('appDownloadPage', 'KYROLLL_DOWNLOAD_PAGE'),
  fallbackCatalogFile: path.join(resourcesDir(), 'catalog.fallback.json'),
  demoArchiveDir: path.join(resourcesDir(), 'demo'),
  pluginArchiveDir: path.join(resourcesDir(), 'plugins'),
  requestTimeoutMs: configNumber('requestTimeoutMs', 'KYROLLL_REQUEST_TIMEOUT_MS', 8000),
  autoCheckOnLaunch: configBoolean('autoCheckOnLaunch', 'KYROLLL_AUTO_CHECK', true),
  supportedArchiveExtensions: ['.zip', '.tar.gz', '.tgz'],
  configFile: configFile(),
};
