'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const config = require('./config');
const catalog = require('./catalog');
const appUpdate = require('./appUpdate');
const installedState = require('./installedState');
const plugins = require('./plugins');
const installer = require('./installer');
const { pluginDirs, platformInfo } = require('./paths');

const isDev = process.argv.includes('--dev');
app.setName(config.appName);
app.setAppUserModelId('com.kyrolll.KYROlll');
const ROOT = path.join(__dirname, '..', '..');
let mainWindow = null;

async function buildSnapshot() {
  const catalogState = catalog.getState();
  const [state, bundles] = await Promise.all([installedState.read(), plugins.scan()]);
  const platform = platformInfo();
  const { views, untracked } = plugins.buildPluginViews({
    catalog: catalogState.catalog,
    state,
    bundles,
    platform: process.platform,
  });

  const updateState = appUpdate.getState();
  return {
    ...catalogState,
    plugins: views,
    untrackedCount: untracked.length,
    platform: {
      id: platform.id,
      key: platform.key,
      name: platform.name,
      label: platform.label,
      formats: platform.formats,
      extension: platform.extension,
      dirs: pluginDirs,
    },
    dirs: { ...pluginDirs },
    stateFile: installedState.stateFile(),
    appVersion: app.getVersion(),
    appUpdate: updateState.info,
    appUpdateSource: updateState.source,
    appUpdateError: updateState.error,
    releaseFeedUrl: updateState.releaseFeedUrl,
  };
}

/** Refresh the plugin catalog and the app release feed together. */
async function refreshAll() {
  await catalog.refresh();
  await appUpdate.check(app.getVersion());
  return buildSnapshot();
}

function sendSnapshot(snapshot) {
  if (mainWindow && !mainWindow.isDestroyed() && snapshot) {
    mainWindow.webContents.send('hub:snapshot-updated', snapshot);
  }
}

async function backgroundUpdateCheck() {
  try {
    const snapshot = await refreshAll();
    sendSnapshot(snapshot);
  } catch {
    // Offline is expected; the renderer keeps the bundled catalog.
  }
}

function registerIpc() {
  ipcMain.handle('hub:snapshot', () => buildSnapshot());

  ipcMain.handle('hub:refresh-catalog', () => refreshAll());

  ipcMain.handle('hub:install', async (event, pluginId) => {
    const plugin = catalog.findPlugin(pluginId);
    if (!plugin) return { ok: false, code: 'UNKNOWN_PLUGIN', error: 'That plugin is not in the current catalog.' };

    const sender = event.sender;
    try {
      const record = await installer.runInstall({
        plugin,
        onProgress: (payload) => {
          if (!sender.isDestroyed()) sender.send('hub:install-progress', payload);
        },
      });
      return { ok: true, record };
    } catch (err) {
      return {
        ok: false,
        code: err.code || 'INSTALL_FAILED',
        error: err.message || 'Installation failed.',
        cancelled: err.code === 'CANCELLED',
      };
    }
  });

  ipcMain.handle('hub:uninstall', async (_event, pluginId) => {
    const plugin = catalog.findPlugin(pluginId);
    const state = await installedState.read();
    const bundles = await plugins.scan();
    const { views } = plugins.buildPluginViews({
      catalog: catalog.getState().catalog,
      state,
      bundles,
      platform: process.platform,
    });
    const view = views.find((entry) => entry.id === pluginId);
    const record = state.plugins[pluginId] || null;

    if (!record && !view?.detectedPaths?.length) {
      return { ok: false, code: 'NOT_INSTALLED', error: 'That plugin is not installed.' };
    }

    const displayName = plugin?.name || view?.name || pluginId;
    const count = new Set([
      ...(record?.bundles || []).map((bundle) => bundle.path),
      ...(view?.detectedPaths || []).map((bundle) => bundle.path),
    ]).size;

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Remove'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Remove plug-in',
      message: `Remove ${displayName}?`,
      detail: `${count || 'All'} installed plug-in ${count === 1 ? 'bundle' : 'bundles'} will be deleted from your ${platformInfo().label} plug-in folder${pluginDirs.AU && pluginDirs.VST3 ? 's' : ''}. Your DAW may need a rescan.`,
    });
    if (response !== 1) return { ok: false, cancelled: true };

    try {
      const result = await installer.uninstallPlugin({
        pluginId,
        plugin,
        record,
        detectedPaths: view?.detectedPaths || [],
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, code: err.code || 'UNINSTALL_FAILED', error: err.message || 'Uninstall failed.' };
    }
  });

  ipcMain.handle('hub:cancel-install', (_event, runId) => ({ cancelled: installer.cancel(runId) }));

  ipcMain.handle('hub:check-app-update', async () => {
    await appUpdate.check(app.getVersion());
    return buildSnapshot();
  });

  ipcMain.handle('hub:open', async (_event, target) => {
    if (target === 'AU' || target === 'VST3') {
      const dir = pluginDirs[target];
      if (!dir) return { ok: false, error: `${target} is not available on ${platformInfo().label}.` };
      await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
      await shell.openPath(dir);
      return { ok: true };
    }
    if (target === 'state') {
      shell.showItemInFolder(installedState.stateFile());
      return { ok: true };
    }
    return { ok: false, error: 'Unknown target.' };
  });

  ipcMain.handle('hub:open-external', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: config.appName,
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0b0b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 22, y: 24 } } : {}),
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.setTitle(config.appName);
  mainWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function checkForUpdatesFromMenu() {
  const snapshot = await refreshAll();
  sendSnapshot(snapshot);
  const update = snapshot.appUpdate;
  if (!update || !update.updateAvailable) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['OK'],
      title: config.appName,
      message: `${config.appName} is up to date.`,
      detail: `You are running version ${app.getVersion()}.`,
    });
    return;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['Later', 'Download Update'],
    defaultId: 1,
    cancelId: 0,
    title: `${config.appName} update available`,
    message: `${config.appName} ${update.latestVersion} is available.`,
    detail: `You are running ${update.currentVersion}.`,
  });
  if (response === 1 && update.downloadUrl) await shell.openExternal(update.downloadUrl);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    {
      label: config.appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => checkForUpdatesFromMenu() },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
            ]
          : []),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setName(config.appName);
    if (process.platform === 'darwin') {
      const iconPath = path.join(ROOT, 'build', 'icon.png');
      if (fs.existsSync(iconPath)) {
        const image = nativeImage.createFromPath(iconPath);
        if (!image.isEmpty()) app.dock.setIcon(image);
      }
    }
    await catalog.init();
    // The bundled catalog is instant; only a remote release feed delays this.
    if (!config.releaseFeedUrl) await appUpdate.check(app.getVersion());
    registerIpc();
    buildMenu();
    createWindow();

    if (config.autoCheckOnLaunch && (config.catalogUrl || config.releaseFeedUrl)) {
      mainWindow.webContents.once('did-finish-load', () => backgroundUpdateCheck());
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
