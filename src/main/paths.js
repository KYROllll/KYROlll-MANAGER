'use strict';

const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

/**
 * Central place for every filesystem location the Hub touches.
 * Env overrides exist so the whole flow can be tested without writing
 * into a real plug-in folder.
 *
 * macOS  : AU  -> ~/Library/Audio/Plug-Ins/Components
 *          VST3 -> ~/Library/Audio/Plug-Ins/VST3
 * Windows: VST3 -> C:\Program Files\Common Files\VST3 (VST3 system folder)
 * Linux  : VST3 -> ~/.vst3 (handy for development)
 */

const home = os.homedir();

/** Normalized platform key used by catalogs, paths and the renderer. */
function platformKey(platform = process.platform) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

function platformInfo(platform = process.platform) {
  const key = platformKey(platform);
  if (key === 'win') {
    return {
      key,
      id: 'win',
      name: 'Windows',
      label: 'Windows',
      formats: ['VST3'],
      extension: '.exe',
    };
  }
  if (key === 'mac') {
    const appleSilicon = process.arch === 'arm64';
    return {
      key,
      id: 'mac',
      name: appleSilicon ? 'macOS (Apple Silicon)' : 'macOS (Intel)',
      label: appleSilicon ? 'Apple Silicon Mac (M-series)' : 'Intel Mac (Intel chip)',
      formats: ['AU', 'VST3'],
      extension: '.dmg',
    };
  }
  return {
    key,
    id: 'linux',
    name: 'Linux',
    label: 'Linux',
    formats: ['VST3'],
    extension: '.AppImage',
  };
}

/** The formats the current platform can actually install and detect. */
function supportedFormats(platform = process.platform) {
  return platformInfo(platform).formats;
}

function windowsVst3Dir() {
  // VST3 bundles are shared machine-wide on Windows. Respect the standard
  // environment variables so non-default Program Files locations still work.
  const common = process.env.CommonProgramFiles || process.env['CommonProgramFiles(x86)'];
  if (common) return path.win32.join(common, 'VST3');
  const base = process.env.ProgramFiles || process.env.ProgramW6432 || 'C:\\Program Files';
  return path.win32.join(base, 'Common Files', 'VST3');
}

function pluginDirsFor(platform = process.platform) {
  const key = platformKey(platform);
  if (key === 'win') {
    return {
      VST3: process.env.KYROLLL_VST3_DIR || windowsVst3Dir(),
    };
  }
  if (key === 'mac') {
    return {
      AU: process.env.KYROLLL_COMPONENTS_DIR || path.join(home, 'Library', 'Audio', 'Plug-Ins', 'Components'),
      VST3: process.env.KYROLLL_VST3_DIR || path.join(home, 'Library', 'Audio', 'Plug-Ins', 'VST3'),
    };
  }
  return {
    VST3: process.env.KYROLLL_VST3_DIR || path.join(home, '.vst3'),
  };
}

// Resolve once at startup; the process platform cannot change at runtime.
const pluginDirs = pluginDirsFor();

function stateDir() {
  if (process.env.KYROLLL_STATE_DIR) return process.env.KYROLLL_STATE_DIR;
  try {
    return app.getPath('userData');
  } catch {
    // Allows config/catalog helpers to be imported by plain-Node scripts.
    return path.join(home, '.kyrolll');
  }
}

function stateFile() {
  return path.join(stateDir(), 'installed.json');
}

function catalogCacheFile() {
  return path.join(stateDir(), 'catalog-cache.json');
}

function configFile() {
  return process.env.KYROLLL_CONFIG_FILE || path.join(stateDir(), 'config.json');
}

function tempDir() {
  try {
    return path.join(app.getPath('temp'), 'kyrolll-hub');
  } catch {
    return path.join(os.tmpdir(), 'kyrolll-hub');
  }
}

function resourcesDir() {
  // src/main -> project root. Works in dev and inside a packaged asar.
  return path.join(__dirname, '..', '..', 'resources');
}

/** Guard that a path lives inside one of the configured plug-in folders. */
function isInsidePluginDir(candidate, dirs = pluginDirs) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const resolved = path.resolve(candidate);
  return Object.values(dirs).some((dir) => {
    if (!dir) return false;
    const root = path.resolve(dir);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  });
}

module.exports = {
  pluginDirs,
  pluginDirsFor,
  platformKey,
  platformInfo,
  supportedFormats,
  isInsidePluginDir,
  stateDir,
  stateFile,
  catalogCacheFile,
  configFile,
  tempDir,
  resourcesDir,
};
