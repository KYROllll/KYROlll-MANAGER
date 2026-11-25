const api = window.kyrolll;

const STEPS = [
  'Preparing download',
  'Downloading archive',
  'Extracting archive',
  'Installing plug-in bundles',
  'Updating local state',
  'Finished',
];

const SOURCE_LABELS = {
  remote: { text: 'Live catalog', className: 'live' },
  cache: { text: 'Cached catalog', className: 'cache' },
  fallback: { text: 'Built-in catalog', className: 'fallback' },
};

const STATUS_LABELS = {
  'not-installed': { text: 'Not Installed', className: '' },
  installed: { text: 'Installed', className: 'installed' },
  'update-available': { text: 'UPDATE AVAILABLE', className: 'update' },
};

let snapshot = null;
let activeInstall = null;
let selectedPluginId = null;
let toastTimer = null;
let refreshing = false;
let appDownload = null;
const dismissedAppUpdates = new Set();
const notifiedAppUpdates = new Set();

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Every visible brand mention uses the authentic wordmark graphic, so the
   name never falls back to a mismatched UI typeface. */
const WORDMARK_SRC = '../assets/kyrolll-wordmark.svg';

function wordmark(modifier) {
  return `<img class="brand-wordmark-img ${modifier}" src="${WORDMARK_SRC}" alt="KYROlll" />`;
}

const WORDMARK_IMG = wordmark('brand-wordmark-img--inline');

function brandTitle(value) {
  return escapeHtml(value).replace(/KYROlll/g, WORDMARK_IMG);
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

/* ---------- platform & versions ---------- */

function platformLabel() {
  return snapshot?.platform?.label || 'macOS';
}

function appInstallerFormat() {
  const platformId = snapshot?.platform?.id || 'mac';
  return platformId === 'win' ? 'EXE' : 'DMG';
}

function appUpdateButtonLabel(update) {
  if (!update?.downloadUrl) return 'View Release';
  const url = String(update.downloadUrl).toLowerCase();
  if (url.endsWith('.dmg')) return 'Download Update (DMG)';
  if (url.endsWith('.exe')) return 'Download Update (EXE)';
  if (url.endsWith('.pkg')) return 'Download Update (PKG)';
  if (url.endsWith('.appimage')) return 'Download Update (AppImage)';
  return 'Download Update';
}

function platformFormats() {
  return snapshot?.platform?.formats || ['AU', 'VST3'];
}

function formatList(formats = platformFormats()) {
  return formats.join(' & ');
}

function installSteps() {
  const formats = platformFormats();
  return STEPS.map((label, index) =>
    index === 3 ? `Installing ${formatList(formats)} bundle${formats.length > 1 ? 's' : ''}` : label
  );
}

function downloadFor(plugin) {
  return plugin?.platformDownload || plugin?.download || null;
}

function versionDelta(plugin) {
  if (!plugin) return '';
  if (plugin.status === 'update-available' && plugin.installedVersion) {
    return `v${plugin.installedVersion} → v${plugin.version}`;
  }
  return `v${plugin.version}`;
}

/* ---------- catalog ---------- */

function renderChip() {
  const chip = $('#catalog-chip');
  const source = SOURCE_LABELS[snapshot?.source] || SOURCE_LABELS.fallback;
  chip.className = `chip ${source.className}`;
  chip.innerHTML = `<i class="dot"></i> ${escapeHtml(source.text)}`;
  chip.title = snapshot?.catalogUrl
    ? `Catalog source: ${snapshot.catalogUrl}`
    : 'Using the catalog bundled with the app.';
}

function renderHero() {
  const plugins = snapshot?.plugins || [];
  const installed = plugins.filter((plugin) => plugin.status !== 'not-installed').length;
  const updates = plugins.filter((plugin) => plugin.status === 'update-available').length;

  $('#hero-stats').innerHTML = [
    { value: String(plugins.length).padStart(2, '0'), label: 'In catalog' },
    { value: String(installed).padStart(2, '0'), label: 'Installed' },
    { value: String(updates).padStart(2, '0'), label: updates === 1 ? 'UPDATE READY' : 'UPDATES READY' },
  ]
    .map(
      (stat) => `
        <div class="stat">
          <span class="stat-value">${escapeHtml(stat.value)}</span>
          <span class="stat-label">${escapeHtml(stat.label)}</span>
        </div>`
    )
    .join('');
}

function renderCatalogMeta() {
  const meta = $('#catalog-meta');
  if (!snapshot) {
    meta.textContent = '';
    return;
  }
  const parts = [snapshot.catalog?.channel || 'stable', `schema v${snapshot.catalog?.schemaVersion ?? 1}`];
  if (snapshot.catalog?.updatedAt) parts.push(`updated ${formatDate(snapshot.catalog.updatedAt)}`);
  meta.textContent = parts.join(' · ');
}

function renderCatalogError() {
  const notice = $('#catalog-error');
  const hasUsableCatalog = (snapshot?.plugins?.length || 0) > 0;
  // A remote miss is routine when offline. Only surface a catalog error when
  // there is genuinely nothing to display.
  if (!snapshot?.error || hasUsableCatalog) {
    notice.hidden = true;
    return;
  }
  notice.hidden = false;
  notice.textContent = snapshot.error;
}

/* ---------- app update ---------- */

const INSTALLER_URL_PATTERN = /\.(dmg|pkg|exe|msi|appimage)$/i;

function isInstallerUrl(url) {
  return Boolean(url) && INSTALLER_URL_PATTERN.test(String(url).split(/[?#]/)[0]);
}

function appDownloadPercent() {
  if (!appDownload) return 0;
  if (appDownload.percent != null) return appDownload.percent;
  if (appDownload.total) return Math.round((appDownload.received / appDownload.total) * 100);
  return 0;
}

/* Button + progress line for the in-app installer download. */
function renderAppDownloadState(update) {
  const button = $('#app-update-download');
  const progress = $('#app-update-progress');
  if (!button || !progress) return;
  const url = update?.downloadUrl || update?.releaseUrl;
  const streamable = isInstallerUrl(update?.downloadUrl);

  if (appDownload?.status === 'running') {
    const percent = appDownloadPercent();
    button.disabled = true;
    button.textContent = percent ? `Downloading ${percent}%` : 'Downloading…';
    button.title = 'Downloading the installer inside KYROlll MANAGER…';
    progress.hidden = false;
    progress.textContent = appDownload.total
      ? `Installer · ${percent}% · ${formatSize(appDownload.received)} of ${formatSize(appDownload.total)}`
      : `Installer · ${percent}%${appDownload.received ? ` · ${formatSize(appDownload.received)}` : ''}`;
    return;
  }

  if (appDownload?.status === 'done') {
    button.disabled = false;
    button.textContent = 'Show Installer';
    button.title = appDownload.file || 'Reveal the downloaded installer';
    progress.hidden = false;
    progress.textContent = `Installer ready${appDownload.total ? ` · ${formatSize(appDownload.total)}` : ''} — open it, then drag KYROlll MANAGER to Applications.`;
    return;
  }

  if (appDownload?.status === 'error') {
    button.disabled = !url;
    button.textContent = streamable ? appUpdateButtonLabel(update) : 'View Release';
    button.title = url || 'No download link has been published yet.';
    progress.hidden = false;
    progress.textContent = appDownload.error || 'Download failed — try again.';
    return;
  }

  button.disabled = !url;
  button.textContent = appUpdateButtonLabel(update);
  button.title = url || 'No download link has been published yet.';
  progress.hidden = true;
  progress.textContent = '';
}

function renderAppUpdate() {
  const section = $('#app-update');
  const update = snapshot?.appUpdate;
  if (!update || !update.updateAvailable || dismissedAppUpdates.has(update.latestVersion)) {
    section.hidden = true;
    return;
  }

  // A newer release resets any finished download from the previous version.
  if (appDownload?.version && appDownload.version !== update.latestVersion) appDownload = null;

  section.hidden = false;
  $('#app-update-version-line').textContent = `v${update.currentVersion} → v${update.latestVersion}`;
  $('#app-update-title').innerHTML = `${wordmark('brand-wordmark-img--inline')} MANAGER ${escapeHtml(update.latestVersion)} is available.`;

  const notes = Array.isArray(update.releaseNotes) ? update.releaseNotes : [];
  const notesEl = $('#app-update-notes');
  if (notes.length) {
    notesEl.innerHTML = `<ul>${notes.map((note) => `<li>${brandTitle(note)}</li>`).join('')}</ul>`;
  } else {
    notesEl.innerHTML = `<p>Download the latest KYROlll MANAGER installer for ${escapeHtml(platformLabel())} (${escapeHtml(appInstallerFormat())}) to get the newest fixes and features.</p>`;
  }

  renderAppDownloadState(update);
}

function maybeNotifyAppUpdate() {
  const update = snapshot?.appUpdate;
  if (!update || !update.updateAvailable || dismissedAppUpdates.has(update.latestVersion)) return;
  if (notifiedAppUpdates.has(update.latestVersion)) return;
  notifiedAppUpdates.add(update.latestVersion);
  showToast(`${update.latestVersion} of KYROlll MANAGER is available.`);
}

async function openAppUpdate() {
  const update = snapshot?.appUpdate;
  if (!update) return;

  if (appDownload?.status === 'done' && appDownload.file) {
    api.revealFile(appDownload.file);
    return;
  }
  if (appDownload?.status === 'running') return;

  const url = update.downloadUrl || update.releaseUrl;
  if (!url) {
    showToast('No app download link has been published yet.');
    return;
  }

  // A release page (no installer asset) still opens in the browser.
  if (!isInstallerUrl(update.downloadUrl)) {
    api.openExternal(url);
    showToast(`Opening KYROlll MANAGER ${update.latestVersion} download…`);
    return;
  }

  appDownload = {
    status: 'running',
    percent: 0,
    received: 0,
    total: update.size || 0,
    file: null,
    version: update.latestVersion,
  };
  renderAppDownloadState(update);

  const result = await api.downloadAppUpdate();
  if (!result?.ok) {
    if (result?.code === 'NOT_INSTALLER') {
      appDownload = null;
      renderAppDownloadState(update);
      api.openExternal(url);
      return;
    }
    appDownload = { status: 'error', error: result?.error || 'Download failed.', version: update.latestVersion };
    renderAppDownloadState(update);
    showToast(result?.error || 'Could not download the installer.');
    return;
  }

  appDownload = {
    status: 'done',
    percent: 100,
    received: result.size || 0,
    total: result.size || 0,
    file: result.file,
    version: update.latestVersion,
  };
  renderAppDownloadState(update);
  showToast(`KYROlll MANAGER ${update.latestVersion} installer saved to Downloads.`);
}

function actionLabel(plugin) {
  if (!downloadFor(plugin)?.url) return 'Unavailable';
  if (plugin.status === 'update-available') return 'Update';
  if (plugin.status === 'installed') return 'Reinstall';
  return 'Install';
}

function releaseNotesBlock(plugin, summary) {
  const notes = Array.isArray(plugin.releaseNotes) && plugin.releaseNotes.length ? plugin.releaseNotes : plugin.changelog;
  if (!Array.isArray(notes) || !notes.length) return '';
  return `<details class="release-notes">
         <summary>${escapeHtml(summary)}</summary>
         <ul>${notes.map((note) => `<li>${brandTitle(note)}</li>`).join('')}</ul>
       </details>`;
}

function renderCard(plugin, index) {
  const status = STATUS_LABELS[plugin.status] || STATUS_LABELS['not-installed'];
  const isFeatured = Boolean(plugin.featured);
  const isUpdate = plugin.status === 'update-available';
  const isInstalled = plugin.status !== 'not-installed';
  const actionDisabled = !downloadFor(plugin)?.url;
  const actionClass = isUpdate ? 'primary' : plugin.status === 'installed' ? 'ghost' : 'primary';
  const notes = releaseNotesBlock(plugin, isUpdate ? `Changelog · ${versionDelta(plugin)}` : `What's new in ${plugin.version}`);

  const formats = (plugin.formats || [])
    .map((format) => {
      const missing = plugin.status !== 'not-installed' && !(plugin.formatsInstalled || []).includes(format);
      return `<span class="format-pill${missing ? ' missing' : ''}" title="${missing ? `${format} not detected on disk` : format}">${escapeHtml(format)}</span>`;
    })
    .join('');

  const versionChip = isUpdate
    ? `<span class="version-chip update-chip" title="Installed ${escapeHtml(plugin.installedVersion || '?')} — catalog ${escapeHtml(plugin.version)}">${escapeHtml(versionDelta(plugin))}</span>`
    : `<span class="version-chip">v${escapeHtml(plugin.version)}</span>`;

  const metaBits = [
    versionDelta(plugin),
    plugin.size ? formatSize(plugin.size) : '',
    plugin.releasedAt ? formatDate(plugin.releasedAt) : '',
    platformLabel(),
  ].filter(Boolean);

  const removeButton = isInstalled
    ? `<button
            type="button"
            class="btn small ghost danger"
            data-action="uninstall"
            data-plugin-id="${escapeHtml(plugin.id)}"
            title="Remove installed plug-in files"
          >Remove</button>`
    : '';

  const previewSrc = plugin.image || plugin.preview || '../assets/kyrolll-soul-plugin.png';
  return `
    <article class="plugin-card${isFeatured ? ' featured' : ''}${isUpdate ? ' update-card' : ''}" data-action="open-detail" data-plugin-id="${escapeHtml(plugin.id)}" data-plugin="${escapeHtml(plugin.id)}">
      <div class="card-preview"><img src="${escapeHtml(previewSrc)}" alt="" /></div>
      <div class="card-top">
        <h3 class="plugin-name">${brandTitle(plugin.name)}</h3>
        ${versionChip}
        ${isFeatured ? '<span class="badge">Flagship</span>' : ''}
        ${isUpdate ? '<span class="badge update-badge">Update</span>' : ''}
      </div>
      ${plugin.tagline ? `<p class="tagline">${brandTitle(plugin.tagline)}</p>` : ''}
      ${plugin.description ? `<p class="description">${brandTitle(plugin.description)}</p>` : ''}
      ${notes}
      <div class="card-foot">
        <div class="formats">${formats}</div>
        <div class="card-actions">
          <span class="status ${status.className}"><span class="status-dot"></span>${status.text}</span>
          ${removeButton}
          <button
            type="button"
            class="btn ${actionClass}"
            data-action="install"
            data-plugin-id="${escapeHtml(plugin.id)}"
            ${actionDisabled ? 'disabled' : ''}
            title="${escapeHtml(metaBits.join(' · '))}"
          >${escapeHtml(actionLabel(plugin))}</button>
        </div>
      </div>
    </article>`;
}

function renderCatalog() {
  const grid = $('#plugin-grid');
  const plugins = snapshot?.plugins || [];
  if (!plugins.length) {
    grid.innerHTML = `<p class="description">No plugins in this catalog yet.</p>`;
    return;
  }
  grid.innerHTML = plugins.map(renderCard).join('');
}

function openDetail(pluginId) {
  const plugin = (snapshot?.plugins || []).find((entry) => entry.id === pluginId);
  if (!plugin) return;
  selectedPluginId = pluginId;
  $('#catalog-section').hidden = true;
  $('#plugin-detail').hidden = false;
  renderDetail(pluginId);
}

function closeDetail() {
  selectedPluginId = null;
  $('#plugin-detail').hidden = true;
  $('#catalog-section').hidden = false;
}

function renderDetail(pluginId) {
  const plugin = (snapshot?.plugins || []).find((entry) => entry.id === pluginId);
  if (!plugin) return;
  const status = STATUS_LABELS[plugin.status] || STATUS_LABELS['not-installed'];
  const isUpdate = plugin.status === 'update-available';
  const isInstalled = plugin.status !== 'not-installed';
  const actionDisabled = !downloadFor(plugin)?.url;
  const actionClass = isUpdate ? 'primary' : plugin.status === 'installed' ? 'ghost' : 'primary';
  const notes = Array.isArray(plugin.releaseNotes) && plugin.releaseNotes.length
    ? `<ul class="detail-notes">${plugin.releaseNotes.map((note) => `<li>${brandTitle(note)}</li>`).join('')}</ul>`
    : '<p class="description">No release notes.</p>';
  const formats = (plugin.formats || [])
    .map((format) => {
      const missing = plugin.status !== 'not-installed' && !(plugin.formatsInstalled || []).includes(format);
      return `<span class="format-pill${missing ? ' missing' : ''}">${escapeHtml(format)}</span>`;
    })
    .join('');

  const installedRow =
    isInstalled && plugin.installedVersion
      ? `<div class="detail-row"><span class="detail-label">Installed</span><span class="detail-value">v${escapeHtml(plugin.installedVersion)}</span></div>`
      : '';
  const changelogTitle = isUpdate ? `Changelog · ${versionDelta(plugin)}` : "What's new";
  const uninstallButton = isInstalled
    ? `<button type="button" class="btn ghost danger" data-action="uninstall" data-plugin-id="${escapeHtml(plugin.id)}">Uninstall</button>`
    : '';

  const previewSrc = plugin.image || plugin.preview || '../assets/kyrolll-soul-plugin.png';
  $('#detail-content').innerHTML = `
    <div class="detail-head">
      <div class="detail-cover"><img src="${escapeHtml(previewSrc)}" alt="" /></div>
      <div class="detail-meta">
        <p class="eyebrow">${wordmark('brand-wordmark-img--eyebrow')} <span class="eyebrow-sep">/</span> ${escapeHtml(plugin.featured ? 'Flagship' : 'Plugin')}</p>
        <h2 class="detail-name">${brandTitle(plugin.name)}</h2>
        <p class="detail-tagline">${brandTitle(plugin.tagline || '')}</p>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-col">
        <h3 class="detail-section-title">Overview</h3>
        <p class="detail-description">${brandTitle(plugin.description || '')}</p>
        <h3 class="detail-section-title">${escapeHtml(changelogTitle)}</h3>
        ${notes}
      </div>
      <div class="detail-col detail-side">
        <div class="detail-row"><span class="detail-label">Version</span><span class="detail-value">${isUpdate ? escapeHtml(versionDelta(plugin)) : `v${escapeHtml(plugin.version)}`}</span></div>
        ${installedRow}
        <div class="detail-row"><span class="detail-label">Status</span><span class="status ${status.className}"><span class="status-dot"></span>${status.text}</span></div>
        <div class="detail-row"><span class="detail-label">Formats</span><span class="formats">${formats}</span></div>
        <div class="detail-row"><span class="detail-label">Platform</span><span class="detail-value">${escapeHtml(platformLabel())}</span></div>
        ${plugin.size ? `<div class="detail-row"><span class="detail-label">Size</span><span class="detail-value">${escapeHtml(formatSize(plugin.size))}</span></div>` : ''}
        ${plugin.releasedAt ? `<div class="detail-row"><span class="detail-label">Released</span><span class="detail-value">${escapeHtml(formatDate(plugin.releasedAt))}</span></div>` : ''}
        <div class="detail-actions">
          <button type="button" class="btn ${actionClass}" data-action="install" data-plugin-id="${escapeHtml(plugin.id)}" ${actionDisabled ? 'disabled' : ''}>${escapeHtml(actionLabel(plugin))}</button>
          ${uninstallButton}
        </div>
      </div>
    </div>`;
}

function renderFooter() {
  if (!snapshot) return;
  $('#app-version').innerHTML = `${wordmark('brand-wordmark-img--footer')}${snapshot.appVersion ? ` ${escapeHtml(snapshot.appVersion)}` : ''}`;
  $('#platform-label').textContent = `Built for ${platformLabel()}`;
}

function render() {
  if (snapshot?.platform?.id) document.body.dataset.platform = snapshot.platform.id;
  renderChip();
  renderHero();
  renderCatalogMeta();
  renderCatalogError();
  renderAppUpdate();
  renderCatalog();
  renderFooter();
  if (selectedPluginId) renderDetail(selectedPluginId);
  maybeNotifyAppUpdate();
}

/* ---------- install sheet ---------- */

function sheetIntent() {
  if (!activeInstall) return 'Installing';
  if (activeInstall.plugin.status === 'update-available') return 'Updating';
  if (activeInstall.plugin.status === 'installed') return 'Reinstalling';
  return 'Installing';
}

function renderSheet() {
  if (!activeInstall) return;
  const { plugin, status, percent, stepIndex, detail, error, result } = activeInstall;
  const sheet = $('.sheet');
  sheet.className = `sheet ${status === 'running' ? 'running' : status}`;

  $('#sheet-eyebrow').textContent = status === 'success' ? 'Complete' : status === 'error' ? 'Failed' : sheetIntent();
  $('#sheet-title').innerHTML = brandTitle(plugin.name);
  const versionLine =
    status === 'running' && plugin.installedVersion && plugin.installedVersion !== plugin.version
      ? `v${plugin.installedVersion} → v${plugin.version}`
      : `v${plugin.version}`;
  $('#sheet-sub').textContent = `${versionLine} · ${plugin.formats.join(' + ')} · ${platformLabel()}`;

  const steps = installSteps();
  $('#progress-fill').style.width = `${status === 'success' ? 100 : percent}%`;
  $('#progress-percent').textContent = `${status === 'success' ? 100 : Math.round(percent)}%`;
  $('#progress-detail').textContent = detail || '';

  $('#step-list').innerHTML = steps.map((label, index) => {
    let stateClass = '';
    let dot = '';
    if (status === 'success' || index < stepIndex) {
      stateClass = 'is-done';
      dot = '✓';
    } else if (index === stepIndex) {
      stateClass = status === 'error' ? 'is-error' : 'is-active';
      dot = status === 'error' ? '!' : '';
    }
    const stepDetail =
      activeInstall.stepDetails[index] ||
      (status === 'success' && index === steps.length - 1 ? 'Ready to use' : '');
    return `
      <li class="step ${stateClass}">
        <span class="step-dot"><span>${dot}</span></span>
        <span class="step-label">${escapeHtml(label)}</span>
        <span class="step-detail">${escapeHtml(stepDetail)}</span>
      </li>`;
  }).join('');

  const resultEl = $('#sheet-result');
  if (status === 'success') {
    resultEl.hidden = false;
    resultEl.className = 'sheet-result success';
    resultEl.innerHTML = `
      <h3>You're up to date.</h3>
      <p><strong>${brandTitle(plugin.name)} ${escapeHtml(plugin.version)}</strong> was placed in your ${escapeHtml(platformLabel())} plug-in folder${(plugin.formats || []).length > 1 ? 's' : ''}.
      Rescan plug-ins in your DAW — or restart it — to see the new version.</p>`;
  } else if (status === 'error') {
    resultEl.hidden = false;
    resultEl.className = 'sheet-result error';
    resultEl.innerHTML = `
      <h3>Installation failed</h3>
      <p>${escapeHtml(error || 'Something went wrong.')}</p>
      <p>Check your connection and try again — nothing was left half-installed.</p>`;
  } else {
    resultEl.hidden = true;
    resultEl.innerHTML = '';
  }

  const secondary = $('#sheet-secondary');
  const primary = $('#sheet-primary');
  if (status === 'running') {
    secondary.textContent = 'Cancel';
    secondary.dataset.action = 'cancel-install';
    primary.hidden = true;
  } else if (status === 'error') {
    secondary.textContent = 'Close';
    secondary.dataset.action = 'close-sheet';
    primary.hidden = false;
    primary.textContent = 'Retry';
    primary.dataset.action = 'retry-install';
  } else {
    secondary.textContent = 'Done';
    secondary.dataset.action = 'close-sheet';
    primary.hidden = true;
  }
  primary.dataset.action = status === 'error' ? 'retry-install' : 'close-sheet';
}

function updateSheetProgress(payload) {
  if (!activeInstall || activeInstall.status !== 'running') return;
  activeInstall.runId = payload.runId;
  activeInstall.percent = payload.percent;
  activeInstall.stepIndex = payload.stepIndex;
  if (payload.detail) {
    activeInstall.detail = payload.detail;
    activeInstall.stepDetails[payload.stepIndex] = payload.detail;
  }
  renderSheet();
}

function openSheet() {
  $('#overlay').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('#overlay').hidden = true;
  document.body.style.overflow = '';
  activeInstall = null;
}

function startInstall(pluginId) {
  const plugin = (snapshot?.plugins || []).find((entry) => entry.id === pluginId);
  if (!plugin) return;

  activeInstall = {
    plugin,
    attempt: 1,
    runId: null,
    status: 'running',
    percent: 0,
    stepIndex: 0,
    detail: 'Starting',
    stepDetails: {},
    error: null,
    result: null,
  };
  openSheet();
  renderSheet();
  runInstallAttempt();
}

async function runInstallAttempt() {
  const attempt = activeInstall.attempt;
  const pluginId = activeInstall.plugin.id;
  const result = await api.install(pluginId);
  if (!activeInstall || activeInstall.plugin.id !== pluginId || activeInstall.attempt !== attempt) return;

  if (result.ok) {
    activeInstall.status = 'success';
    activeInstall.result = result.record;
    activeInstall.percent = 100;
    activeInstall.stepIndex = STEPS.length;
    renderSheet();
    refreshSnapshot({ quiet: true });
    return;
  }

  if (result.cancelled) {
    closeSheet();
    showToast('Installation cancelled.');
    return;
  }

  activeInstall.status = 'error';
  activeInstall.error = result.error;
  activeInstall.stepIndex = Math.max(0, Math.min(activeInstall.stepIndex, STEPS.length - 1));
  renderSheet();
}

function retryInstall() {
  if (!activeInstall) return;
  activeInstall.attempt += 1;
  activeInstall.status = 'running';
  activeInstall.percent = 0;
  activeInstall.stepIndex = 0;
  activeInstall.detail = 'Starting';
  activeInstall.stepDetails = {};
  activeInstall.error = null;
  renderSheet();
  runInstallAttempt();
}

function cancelInstall() {
  if (!activeInstall) return;
  api.cancelInstall(activeInstall.runId);
  $('#progress-detail').textContent = 'Cancelling…';
}

/* ---------- data & feedback ---------- */

function showToast(message) {
  const toast = $('#toast');
  // Messages can include the product or plug-in name; keep brand mentions as
  // the authentic wordmark and escape all other text before injecting.
  toast.innerHTML = brandTitle(message);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

async function refreshSnapshot() {
  snapshot = await api.getSnapshot();
  render();
}

async function handleRefresh({ silent = false } = {}) {
  if (refreshing) return;
  if (!snapshot?.catalogUrl && !snapshot?.releaseFeedUrl) {
    if (!silent) showToast('The built-in catalog is current.');
    return;
  }
  const button = $('#refresh-btn');
  refreshing = true;
  button.disabled = true;
  button.classList.add('spinning');
  try {
    snapshot = await api.refreshCatalog();
    render();
    if (!silent) showToast(snapshot.error ? 'Live catalog unavailable — using the local copy.' : 'Catalog and app releases are up to date.');
  } catch (err) {
    if (!silent) showToast('Live catalog unavailable — using the local copy.');
  } finally {
    refreshing = false;
    button.disabled = false;
    button.classList.remove('spinning');
  }
}

async function removePlugin(pluginId) {
  if (activeInstall) return;
  try {
    const result = await api.uninstall(pluginId);
    if (!result.ok) {
      if (!result.cancelled) showToast(result.error || 'Could not remove the plug-in.');
      return;
    }
    const name = result.plugin || 'Plug-in';
    const count = (result.removed || []).length;
    showToast(`${name} removed${count ? ` · ${count} bundle${count === 1 ? '' : 's'} deleted` : ''}.`);
    await refreshSnapshot();
  } catch (err) {
    showToast('Could not remove the plug-in.');
  }
}

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) {
    if (event.target.id === 'overlay' && activeInstall?.status !== 'running') closeSheet();
    return;
  }
  if (trigger.matches(':disabled') || trigger.getAttribute('aria-disabled') === 'true') return;
  // Keep nested details/buttons from accidentally opening a catalog card.
  if (trigger.dataset.action === 'open-detail' && event.target.closest('.release-notes, button, a, input, textarea, select')) return;
  const action = trigger.dataset.action;
  switch (action) {
    case 'open-detail':
      openDetail(trigger.dataset.pluginId);
      break;
    case 'back-to-catalog':
      closeDetail();
      break;
    case 'install':
      startInstall(trigger.dataset.pluginId);
      break;
    case 'uninstall':
      removePlugin(trigger.dataset.pluginId);
      break;
    case 'download-app-update':
      openAppUpdate();
      break;
    case 'dismiss-app-update':
      if (snapshot?.appUpdate?.latestVersion) dismissedAppUpdates.add(snapshot.appUpdate.latestVersion);
      renderAppUpdate();
      break;
    case 'refresh':
      handleRefresh();
      break;
    case 'cancel-install':
      cancelInstall();
      break;
    case 'retry-install':
      retryInstall();
      break;
    case 'close-sheet':
      closeSheet();
      break;
    default:
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !activeInstall) return;
  if (activeInstall.status === 'running') cancelInstall();
  else closeSheet();
});

api.onInstallProgress(updateSheetProgress);

api.onSnapshotUpdated((next) => {
  if (!next) return;
  snapshot = next;
  render();
});

api.onAppDownloadProgress((payload) => {
  if (!appDownload || appDownload.status !== 'running' || !payload) return;
  if (payload.phase === 'error') {
    appDownload = { status: 'error', error: payload.error || 'Download failed.', version: appDownload.version };
  } else {
    if (payload.percent != null) appDownload.percent = payload.percent;
    if (payload.received != null) appDownload.received = payload.received;
    if (payload.total) appDownload.total = payload.total;
    if (payload.file) appDownload.file = payload.file;
    if (payload.phase === 'done') {
      appDownload.status = 'done';
      appDownload.percent = 100;
    }
  }
  renderAppDownloadState(snapshot?.appUpdate);
});

(async function boot() {
  // First paint uses the bundled/cached catalog; a configured remote check
  // arrives moments later through hub:snapshot-updated.
  await refreshSnapshot();
})();
