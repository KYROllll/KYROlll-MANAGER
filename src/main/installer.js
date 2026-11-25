'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { net } = require('electron');
const extractZip = require('extract-zip');
const tar = require('tar');
const config = require('./config');
const catalog = require('./catalog');
const { pluginDirs, tempDir, supportedFormats, platformKey, isInsidePluginDir } = require('./paths');
const installedState = require('./installedState');

/**
 * Install pipeline:
 *   prepare → download → extract → place bundles → write state
 * Downloads land in the OS temp folder. The extracted archive is searched
 * for .component / .vst3 bundles for the current platform, which are staged
 * next to their final location and swapped in with a backup so a failed copy
 * never leaves a half-written plug-in behind.
 */

const runs = new Map();
let runCounter = 0;

const STEP = {
  preparing: { index: 0, label: 'Preparing download' },
  downloading: { index: 1, label: 'Downloading archive' },
  extracting: { index: 2, label: 'Extracting archive' },
  installing: { index: 3, label: 'Installing plug-in bundles' },
  finalizing: { index: 4, label: 'Updating local state' },
  done: { index: 5, label: 'Finished' },
};

class InstallError extends Error {
  constructor(message, code = 'INSTALL_FAILED') {
    super(message);
    this.code = code;
  }
}

function ensureNotCancelled(run) {
  if (run.cancelled) throw new InstallError('Installation cancelled.', 'CANCELLED');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function emit(run, phase, percent, extra = {}) {
  const step = STEP[phase] || STEP.preparing;
  const label = phase === 'installing' ? `Installing ${run.formatsLabel} bundle${run.formatsLabel.includes('&') ? 's' : ''}` : step.label;
  run.onProgress({
    runId: run.id,
    pluginId: run.plugin.id,
    phase,
    stepIndex: step.index,
    stepLabel: label,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    ...extra,
  });
}

async function fileSize(file) {
  try {
    const stat = await fs.stat(file);
    return stat.size;
  } catch {
    return 0;
  }
}

/** Copy a local file with coarse progress so the UI still animates. */
async function copyLocalFile(source, destination, onProgress) {
  const total = await fileSize(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await new Promise((resolve, reject) => {
    const reader = fsSync.createReadStream(source);
    const writer = fsSync.createWriteStream(destination);
    let received = 0;
    reader.on('data', (chunk) => {
      received += chunk.length;
      if (total) onProgress(received / total);
    });
    reader.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', resolve);
    reader.pipe(writer);
  });
  return total;
}

/** Demo archives ship with the app; the same flow runs, just without network. */
async function demoArchivePath(url) {
  const name = url.replace('demo://', '').replace(/[^a-z0-9-]/gi, '');
  const candidates = [`${name}.zip`, `${name}.tar.gz`];
  for (const candidate of candidates) {
    const file = path.join(config.demoArchiveDir, candidate);
    try {
      await fs.access(file);
      return file;
    } catch {
      // try next
    }
  }
  throw new InstallError(`Demo archive for "${name}" is missing. Run "npm run demo:archive" to generate it.`, 'DEMO_MISSING');
}

/**
 * App-managed plug-in packages are shipped inside the desktop app. Catalogs
 * reference them with app://plugins/<archive> so there is no standalone
 * plug-in download URL to publish. Only a single archive name is accepted;
 * the resolved path can never escape the bundled package directory.
 */
async function appArchivePath(url) {
  const prefix = 'app://plugins/';
  const name = url.startsWith(prefix) ? url.slice(prefix.length) : '';
  if (!name || !/^[a-z0-9][a-z0-9._-]*\.(zip|tar\.gz|tgz)$/i.test(name)) {
    throw new InstallError(`Invalid app-managed plug-in package URL: ${url}`, 'APP_PACKAGE_INVALID');
  }
  const file = path.join(config.pluginArchiveDir, name);
  try {
    await fs.access(file);
  } catch {
    throw new InstallError(
      `The app-managed plug-in package "${name}" is missing from this KYROlll build. Update KYROlll and try again.`,
      'APP_PACKAGE_MISSING'
    );
  }
  return file;
}

function downloadHttp(url, destination, run, onProgress) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'follow' });
    let received = 0;
    let total = 0;
    let settled = false;
    let inactivity;
    const writer = fsSync.createWriteStream(destination);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivity);
      writer.destroy();
      request.abort();
      reject(err instanceof InstallError ? err : new InstallError(`Download failed: ${err.message}`, 'DOWNLOAD_FAILED'));
    };

    const resetInactivity = () => {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => fail(new InstallError('Download stalled — no data received for 45 seconds.', 'DOWNLOAD_STALLED')), 45000);
    };

    writer.on('error', fail);
    writer.on('finish', () => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivity);
      resolve();
    });

    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        fail(new InstallError(`Server responded with HTTP ${response.statusCode} for the download URL.`, 'DOWNLOAD_HTTP'));
        response.resume();
        return;
      }
      const lengthHeader = response.headers['content-length'];
      total = parseInt(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader, 10) || 0;
      resetInactivity();

      response.on('data', (chunk) => {
        if (run.cancelled) {
          fail(new InstallError('Installation cancelled.', 'CANCELLED'));
          return;
        }
        received += chunk.length;
        writer.write(chunk);
        resetInactivity();
        if (total) {
          onProgress(received / total, `${formatBytes(received)} of ${formatBytes(total)}`);
        } else {
          onProgress(null, formatBytes(received));
        }
      });
      response.on('end', () => {
        clearTimeout(inactivity);
        writer.end();
      });
      response.on('error', fail);
    });

    request.on('error', fail);
    resetInactivity();
    request.end();
  });
}

async function download(plugin, downloadInfo, destination, run) {
  const url = downloadInfo.url;
  if (!url) throw new InstallError('This catalog entry has no download URL for your platform.', 'NO_DOWNLOAD_URL');

  await fs.mkdir(path.dirname(destination), { recursive: true });

  if (url.startsWith('demo://')) {
    const archive = await demoArchivePath(url);
    await copyLocalFile(archive, destination, (ratio) => {
      emit(run, 'downloading', 8 + ratio * 50, {
        detail: ratio >= 1 ? 'Demo archive' : `Copying demo archive ${Math.round(ratio * 100)}%`,
      });
    });
    return;
  }

  if (url.startsWith('app://')) {
    const archive = await appArchivePath(url);
    await copyLocalFile(archive, destination, (ratio) => {
      emit(run, 'downloading', 8 + ratio * 50, {
        detail: ratio >= 1 ? 'App-managed package ready' : `Preparing app-managed package ${Math.round(ratio * 100)}%`,
      });
    });
    return;
  }

  if (url.startsWith('file://') || !/^https?:\/\//i.test(url)) {
    const source = url.startsWith('file://') ? require('node:url').fileURLToPath(url) : path.resolve(url);
    await copyLocalFile(source, destination, (ratio) => {
      emit(run, 'downloading', 8 + ratio * 50, { detail: `Reading ${path.basename(source)}` });
    });
    return;
  }

  await downloadHttp(url, destination, run, (ratio, detail) => {
    const percent = ratio === null ? 12 : 8 + ratio * 50;
    emit(run, 'downloading', percent, { detail });
  });
}

async function extractArchive(archive, destination) {
  await fs.mkdir(destination, { recursive: true });
  if (archive.toLowerCase().endsWith('.zip')) {
    await extractZip(archive, { dir: destination });
    return;
  }
  if (/\.(tar\.gz|tgz)$/i.test(archive)) {
    await tar.x({ file: archive, cwd: destination, strict: true });
    return;
  }
  throw new InstallError(`Unsupported archive type "${path.extname(archive)}". Use .zip, .tar.gz or .tgz.`, 'UNSUPPORTED_ARCHIVE');
}

/**
 * Breadth-first search for plugin bundles, never descending into a bundle.
 * Only formats the current platform can install are returned, so a macOS
 * archive installed on Windows simply ignores its .component payload.
 */
async function findBundles(root, formats = supportedFormats()) {
  const allowed = new Set(formats);
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '__MACOSX' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const extension = path.extname(entry.name).toLowerCase();
      if (extension === '.component' || extension === '.vst3') {
        const format = extension === '.component' ? 'AU' : 'VST3';
        if (allowed.has(format)) found.push({ format, path: full, name: entry.name });
      } else if (depth < 4) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return found;
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function placeBundles(bundles, run) {
  const swaps = [];
  const staged = [];

  try {
    for (const bundle of bundles) {
      ensureNotCancelled(run);
      const targetDir = pluginDirs[bundle.format];
      if (!targetDir) throw new InstallError(`No install location configured for ${bundle.format} on ${process.platform}.`, 'NO_TARGET_DIR');
      await fs.mkdir(targetDir, { recursive: true });

      const target = path.join(targetDir, bundle.name);
      const staging = path.join(targetDir, `.${bundle.name}.staging-${run.id}`);
      await fs.rm(staging, { recursive: true, force: true });
      await fs.cp(bundle.path, staging, { recursive: true, verbatimSymlinks: true });
      staged.push({ bundle, staging, target });
    }

    for (const item of staged) {
      ensureNotCancelled(run);
      let backup = null;
      try {
        await fs.access(item.target);
        backup = `${item.target}.backup-${run.id}`;
        await fs.rm(backup, { recursive: true, force: true });
        await fs.rename(item.target, backup);
      } catch {
        backup = null;
      }
      try {
        await fs.rename(item.staging, item.target);
      } catch (err) {
        if (backup) await fs.rename(backup, item.target).catch(() => {});
        throw new InstallError(`Could not place ${item.bundle.name}: ${err.message}`, 'PLACE_FAILED');
      }
      swaps.push({ target: item.target, backup });
      emit(run, 'installing', 75 + (swaps.length / staged.length) * 15, { detail: `Placed ${item.bundle.name}` });
    }
  } catch (err) {
    // Roll back every bundle already swapped in during this run.
    for (const { target, backup } of swaps.reverse()) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      if (backup) await fs.rename(backup, target).catch(() => {});
    }
    throw err;
  } finally {
    for (const { staging } of staged) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    for (const { backup } of swaps) {
      if (backup) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    }
  }

  return swaps.map(({ target }) => target);
}

async function runInstall({ plugin, onProgress }) {
  if (runs.size > 0) throw new InstallError('Another installation is already running.', 'BUSY');
  const downloadInfo = catalog.downloadFor(plugin);
  if (!downloadInfo || !downloadInfo.url) {
    throw new InstallError('This catalog entry has no download for your platform.', 'NO_DOWNLOAD_URL');
  }

  const platformFormats = supportedFormats();
  runCounter += 1;
  const run = {
    id: `${Date.now().toString(36)}-${runCounter}`,
    plugin,
    downloadInfo,
    onProgress,
    cancelled: false,
    formatsLabel: platformFormats.join(' & '),
  };
  runs.set(run.id, run);

  const workDir = path.join(tempDir(), run.id);
  const urlPath = downloadInfo.url.split(/[?#]/)[0];
  const extMatch = /\.(zip|tar\.gz|tgz)$/i.exec(urlPath);
  const archive = path.join(workDir, `archive${extMatch ? extMatch[0].toLowerCase() : '.zip'}`);
  const extractDir = path.join(workDir, 'extracted');
  const startedAt = Date.now();

  try {
    emit(run, 'preparing', 3, { detail: `Preparing ${plugin.name} ${plugin.version}` });
    await fs.mkdir(workDir, { recursive: true });
    ensureNotCancelled(run);

    emit(run, 'downloading', 8, { detail: 'Starting download' });
    await download(plugin, downloadInfo, archive, run);
    ensureNotCancelled(run);

    const stats = await fs.stat(archive);
    emit(run, 'downloading', 58, { detail: `Downloaded ${formatBytes(stats.size)}` });

    if (downloadInfo.size && stats.size !== downloadInfo.size) {
      throw new InstallError(
        `Downloaded archive is ${formatBytes(stats.size)} but the catalog lists ${formatBytes(downloadInfo.size)}.`,
        'SIZE_MISMATCH'
      );
    }

    if (downloadInfo.sha256) {
      emit(run, 'extracting', 60, { detail: 'Verifying checksum' });
      const digest = await sha256(archive);
      if (digest !== downloadInfo.sha256) {
        throw new InstallError('Checksum mismatch — the downloaded archive is incomplete or corrupted.', 'CHECKSUM_MISMATCH');
      }
    }

    emit(run, 'extracting', 62, { detail: 'Unpacking archive' });
    await extractArchive(archive, extractDir);
    ensureNotCancelled(run);
    emit(run, 'extracting', 71, { detail: 'Looking for plugin bundles' });

    const bundles = await findBundles(extractDir, platformFormats);
    if (!bundles.length) {
      throw new InstallError(
        `The archive does not contain any ${platformFormats.join(' or ')} bundles for ${process.platform}.`,
        'NO_BUNDLES'
      );
    }
    run.formatsLabel = [...new Set(bundles.map((bundle) => bundle.format))].join(' & ');

    emit(run, 'installing', 74, { detail: bundles.map((b) => b.format).join(' + ') });
    const placed = await placeBundles(bundles, run);
    ensureNotCancelled(run);

    emit(run, 'finalizing', 94, { detail: 'Writing installed.json' });
    const record = {
      version: plugin.version,
      platform: platformKey(),
      installedAt: new Date().toISOString(),
      sourceUrl: downloadInfo.url,
      bundles: bundles.map((bundle, index) => ({
        format: bundle.format,
        name: bundle.name,
        path: placed[index],
      })),
    };
    await installedState.setRecord(plugin.id, record);

    emit(run, 'done', 100, {
      detail: `Installed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      bundles: record.bundles,
    });
    return record;
  } finally {
    runs.delete(run.id);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Remove every bundle that belongs to a plugin from the platform plug-in
 * folders, then forget the state record. Paths are validated against the
 * configured plug-in folders first so a malformed installed.json can never
 * turn this into an arbitrary delete.
 */
async function uninstallPlugin({ pluginId, plugin = null, record = null, detectedPaths = [] }) {
  if (runs.size > 0) throw new InstallError('Another installation is running. Try again when it finishes.', 'BUSY');

  const candidates = new Map();
  for (const bundle of record?.bundles || []) {
    if (bundle && typeof bundle.path === 'string') candidates.set(path.resolve(bundle.path), bundle.format || path.extname(bundle.path));
  }
  for (const detected of detectedPaths || []) {
    if (detected && typeof detected.path === 'string') candidates.set(path.resolve(detected.path), detected.format || path.extname(detected.path));
  }

  const removed = [];
  const skipped = [];
  const failed = [];

  for (const [candidate, format] of candidates) {
    const extension = path.extname(candidate).toLowerCase();
    const validFormat = format === 'AU' || format === 'VST3';
    if (!validFormat || (extension !== '.component' && extension !== '.vst3') || !isInsidePluginDir(candidate)) {
      skipped.push({ path: candidate, reason: 'outside-configured-plugin-folders' });
      continue;
    }
    try {
      const existed = fsSync.existsSync(candidate);
      await fs.rm(candidate, { recursive: true, force: true });
      if (existed) removed.push(candidate);
    } catch (err) {
      failed.push({ path: candidate, error: err.message });
    }
  }

  if (failed.length) {
    const detail = failed.map((item) => `${path.basename(item.path)}: ${item.error}`).join('; ');
    throw new InstallError(
      `Could not remove ${failed.length === 1 ? 'a plug-in bundle' : 'some plug-in bundles'} — close your DAW and try again. ${detail}`,
      'UNINSTALL_FAILED'
    );
  }

  await installedState.removeRecord(pluginId);
  return { removed, skipped, pluginId, plugin: plugin?.name || null };
}

function cancel(runId) {
  if (runId && runs.has(runId)) {
    runs.get(runId).cancelled = true;
    return true;
  }
  for (const run of runs.values()) run.cancelled = true;
  return runs.size > 0;
}

module.exports = { runInstall, uninstallPlugin, cancel, InstallError, findBundles, formatBytes };
