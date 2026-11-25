# KYROlll Hub

A standalone **KYROlll** desktop app for macOS and Windows — a plugin manager
and updater for KYROlll audio plugins. It discovers, installs, updates, removes
and tracks KYROlll AU / VST3 plug-ins directly in your platform plug-in folders,
and it checks for new versions of both plugins and the KYROlll app itself.

Built with Electron (main + renderer + preload), plain HTML/CSS/JS (no bundler),
and Node's filesystem APIs. The whole thing runs offline out of the box thanks to
a bundled demo catalog and demo archives.

> Brand name is **KYROlll** — with three lowercase `l`s.

## Features

- **Live catalog + clean offline fallback** — fetches a remote `catalog.json`
  (GitHub raw, GitHub Releases, kyrolll.store, S3, or any URL). Falls back to a
  last-known-good cache and then the bundled catalog, so the app always opens.
- **Real plugin update detection** — compares the installed bundle version
  against the catalog version and shows **Update Available**, the version delta
  (`v1.3.0 → v1.4.0`), and the changelog. One click installs the update.
- **Install / update / uninstall** — the install pipeline downloads, verifies
  SHA-256 and archive size, extracts, stages and atomically swaps bundles. Remove
  deletes the installed bundles from the plug-in folders and clears local state.
- **Per-platform downloads** — catalog entries can publish separate macOS and
  Windows archives with their own URL, checksum and size. The Windows view only
  exposes VST3, because AU is macOS-only.
- **App-level update check** — compares the running KYROlll app version with the
  latest release advertised by the catalog (`app`) or a separate release feed.
  A banner and toast notify you, with a direct download/update action.
- **Cross-platform paths** — macOS AU/VST3 folders stay unchanged; Windows
  installs VST3 into `C:\Program Files\Common Files\VST3`.
- **Extensible** — adding a plugin or shipping a new version is a catalog JSON
  edit plus a release bundle. No app code changes.
- **Graceful errors** — clear messages, rollback on failed placement, retry.

## Project structure

```
KYROlll - APP/
├── package.json
├── catalog.json                   # live catalog served from the GitHub repo
├── resources/
│   ├── catalog.fallback.json      # built-in catalog (demo)
│   └── demo/                      # offline demo archives (zip)
├── src/
│   ├── main/                      # Electron main process (Node)
│   │   ├── main.js                # window, IPC, menus, app lifecycle
│   │   ├── paths.js               # per-platform locations (+ env overrides)
│   │   ├── config.js              # env + config.json + defaults
│   │   ├── net-fetch.js           # shared http/file GET helper
│   │   ├── catalog.js             # remote/cache/fallback + platform downloads
│   │   ├── appUpdate.js           # app release feed / catalog app check
│   │   ├── installedState.js      # installed.json read/write
│   │   ├── plugins.js             # cross-platform bundle scan + status logic
│   │   └── installer.js           # download/extract/swap + uninstall pipeline
│   ├── preload/preload.js         # contextBridge -> window.kyrolll
│   └── renderer/                  # UI (HTML/CSS/JS, no bundler)
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── build/
│   ├── icon.svg                   # source for the app icon
│   └── icon.png                   # generated 1024x1024 (npm run icon)
├── scripts/
│   ├── build-icon.py              # SVG -> PNG via Electron
│   ├── make-demo-archives.js      # regenerate offline demo zips
│   ├── smoke-install.js           # end-to-end install smoke test
│   ├── smoke-update.js            # update detection + uninstall smoke test
│   ├── smoke-ui.js                # renderer/update-banner UI smoke test
│   └── verify-build-config.js     # static mac + Windows build checks
└── README.md
```

## Architecture

```
┌──────────────────── renderer (sandboxed) ────────────────────┐
│  index.html / styles.css / app.js                            │
│  talks to main only through window.kyrolll (contextBridge)   │
└──────────────┬───────────────────────────────────────────────┘
               │ IPC (invoke / on)
┌──────────────┴─────────────────── main process ───────────────┐
│  main.js        window, menus, IPC handlers, snapshot builder │
│  catalog.js     remote → cache → fallback, platform downloads │
│  appUpdate.js   catalog app metadata / release feed           │
│  plugins.js     scan bundles, buildPluginViews()              │
│  installer.js   download, verify, extract, place, uninstall   │
│  installedState installed.json (atomic writes)                │
│  paths.js       platform locations, env/config overrides      │
└──────────────────────────────────────────────────────────────┘
```

- **contextIsolation: true, nodeIntegration: false, sandbox: true** in the renderer.
- All filesystem/network work lives in the main process; the renderer only
  receives structured snapshots and progress events.
- `buildPluginViews()` derives status from what is actually on disk, so deleting
  a bundle by hand immediately flips the app back to "Not Installed".
- A configured remote catalog is refreshed automatically after first paint; the
  renderer receives the refreshed snapshot through `hub:snapshot-updated`.

## Catalog JSON format (schema v2)

```json
{
  "schemaVersion": 2,
  "updatedAt": "2026-11-24T00:00:00Z",
  "channel": "stable",
  "app": {
    "latestVersion": "1.1.0",
    "releasedAt": "2026-11-24",
    "releaseNotes": ["What changed in this app release"],
    "downloads": {
      "mac": { "url": "https://.../KYROlll-1.1.0.dmg" },
      "win": { "url": "https://.../KYROlll-Setup-1.1.0.exe" }
    },
    "downloadPage": "https://kyrolll.store"
  },
  "plugins": [
    {
      "id": "kyrolll-soul",
      "name": "KYROlll SOUL",
      "version": "1.4.0",
      "tagline": "Analog soul, tape-worn and alive.",
      "description": "Long-form description shown on the card.",
      "identifier": "store.kyrolll.soul",
      "formats": ["AU", "VST3"],
      "featured": true,
      "releasedAt": "2026-11-24",
      "size": 48261120,
      "downloads": {
        "mac": {
          "url": "https://.../KYROlll%20SOUL-1.4.0-mac.zip",
          "sha256": "optional-hex-digest",
          "size": 48261120
        },
        "win": {
          "url": "https://.../KYROlll%20SOUL-1.4.0-win.zip",
          "sha256": "optional-hex-digest",
          "size": 51234567
        }
      },
      "releaseNotes": ["Changelog shown for this version"],
      "order": 1
    }
  ]
}
```

Field reference:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique plugin id. Used as the key in `installed.json`. |
| `name` | yes | Display name. Also used to match bundles on disk. |
| `version` | yes | Semver-ish (`1.4.0`, `0.9.4-beta.1`). Drives update detection. |
| `identifier` | no | Bundle id prefix. Defaults to `store.kyrolll.<id>`. |
| `formats` | no | `["AU", "VST3"]` (default). Windows filters this to VST3. |
| `downloads.mac` | no* | macOS archive: `url`, optional `sha256`, optional `size`. |
| `downloads.win` | no* | Windows archive: `url`, optional `sha256`, optional `size`. |
| `download.url` | legacy | Single-archive fallback, treated as the macOS/default download. |
| `download.sha256` | no | Verified after download when present. |
| `downloads.*.size` | no | Archive bytes; verified after download when present. |
| `releaseNotes` | no | Array of strings; also accepted as `changelog`. |
| `app.latestVersion` | no | Latest KYROlll desktop release for the app update check. |
| `app.downloads` | no | macOS / Windows app installers for the update action. |
| `app.downloadPage` | no | Fallback download/release page. |

\* At least one platform download should exist. A legacy `download` object still
works and is exposed to Windows only when no explicit `win` download exists.

`schemaVersion`, `updatedAt`, `channel` are optional metadata displayed in the UI.

## Configuration

Configuration is read from environment variables first, then `config.json` in
the app's userData folder (or `KYROLLL_CONFIG_FILE`), then defaults. The
default live catalog is the `catalog.json` in this repository:

`https://raw.githubusercontent.com/KYROllll/KYROlll-APP-/main/catalog.json`

```json
{
  "catalogUrl": "https://raw.githubusercontent.com/KYROllll/KYROlll-APP-/main/catalog.json",
  "releaseFeedUrl": "https://api.github.com/repos/KYROllll/KYROlll-APP-/releases/latest",
  "requestTimeoutMs": 8000,
  "autoCheckOnLaunch": true,
  "appDownloadPage": "https://kyrolll.store"
}
```

- `KYROLLL_CATALOG_URL` — live catalog URL (https://, file://, or local path).
- `KYROLLL_RELEASE_FEED_URL` — optional app release feed. Accepts either
  `{ "latestVersion": "...", "downloads": { ... } }` or the GitHub
  `releases/latest` payload (`tag_name`, `body`, `assets`, `html_url`).
- `KYROLLL_REQUEST_TIMEOUT_MS`, `KYROLLL_AUTO_CHECK`, `KYROLLL_DOWNLOAD_PAGE`,
  `KYROLLL_CONFIG_FILE` — corresponding overrides.

The repository catalog is fetched after first paint, so the bundled catalog is
available immediately. If the raw URL is unreachable, the app keeps the last
known good cached catalog or falls back to the bundled one without blocking the
UI. Set `KYROLLL_CATALOG_URL` / `KYROLLL_RELEASE_FEED_URL` to override the
defaults.

User data locations:

- macOS: `~/Library/Application Support/KYROlll/`
- Windows: `%APPDATA%\KYROlll\`

## Local state (`installed.json`)

```json
{
  "schemaVersion": 1,
  "plugins": {
    "kyrolll-soul": {
      "version": "1.3.0",
      "platform": "mac",
      "installedAt": "2026-11-24T10:00:00.000Z",
      "sourceUrl": "demo://kyrolll-soul",
      "bundles": [
        { "format": "AU", "name": "KYROlll SOUL.component", "path": "/Users/.../KYROlll SOUL.component" },
        { "format": "VST3", "name": "KYROlll SOUL.vst3", "path": "/Users/.../KYROlll SOUL.vst3" }
      ]
    }
  }
}
```

## Plug-in detection & install locations

| Platform | Format | Folder |
|---|---|---|
| macOS | AU | `~/Library/Audio/Plug-Ins/Components` (`*.component`) |
| macOS | VST3 | `~/Library/Audio/Plug-Ins/VST3` (`*.vst3`) |
| Windows | VST3 | `C:\Program Files\Common Files\VST3` (`*.vst3`) |

For each bundle the app reads `Contents/Info.plist` (`CFBundleShortVersionString`,
`CFBundleIdentifier`, `CFBundleName`). Windows VST3 bundles without an Info.plist
fall back to `Contents/moduleinfo.json` where available. A bundle is matched to a
catalog entry when its identifier starts with the entry's `identifier`, or its
normalized name equals the entry's name. Status is derived from disk **and** the
installed record:

- **Not Installed** — no matching bundle on disk.
- **Installed** — bundle present, installed version ≥ catalog version.
- **Update Available** — bundle present, but catalog version is newer; the UI
  shows the version delta, changelog, and an **Update** action.

The environment overrides `KYROLLL_COMPONENTS_DIR` and `KYROLLL_VST3_DIR` work on
every platform (used by the smoke tests and for custom install locations).

## Install, update & uninstall flow

1. `preparing` — validate the per-platform download, create temp workspace.
2. `downloading` — fetch archive with progress (`https`, `file://`, or demo).
3. `extracting` — verify size (if listed) and SHA-256 (if listed), then unzip /
   untar and keep only bundles valid for the current platform.
4. `installing` — stage each bundle next to its target and atomically swap
   (with backup + rollback on failure).
5. `finalizing` — write `installed.json` (version + bundle paths).
6. `done` — success screen reminds you to **rescan / restart your DAW**.

**Update** uses the same pipeline: the newer bundle replaces the old one and the
record is rewritten. **Remove / Uninstall** validates every recorded or detected
path against the configured plug-in folders, deletes `.component` / `.vst3`
bundles recursively, and clears the `installed.json` entry. A native confirmation
dialog is shown first, and a locked bundle (DAW still running) reports a clear
error instead of partially forgetting the install.

## Repository catalog & release assets

The committed [`catalog.json`](catalog.json) is fetched from the `main` branch:

- Raw catalog: `https://raw.githubusercontent.com/KYROllll/KYROlll-APP-/main/catalog.json`
- Releases: `https://github.com/KYROllll/KYROlll-APP-/releases/latest`

Upload the first release assets with these exact names so the catalog's
`releases/latest/download/...` URLs resolve immediately:

| Asset | URL |
|---|---|
| macOS DMG | `https://github.com/KYROllll/KYROlll-APP-/releases/latest/download/KYROlll-1.0.0-arm64.dmg` |
| macOS ZIP | `https://github.com/KYROllll/KYROlll-APP-/releases/latest/download/KYROlll-1.0.0-arm64-mac.zip` |
| Windows installer | `https://github.com/KYROllll/KYROlll-APP-/releases/latest/download/KYROlll%20Setup%201.0.0.exe` |
| Windows ZIP | `https://github.com/KYROllll/KYROlll-APP-/releases/latest/download/KYROlll-1.0.0-win.zip` |
| KYROlll SOUL macOS | `https://github.com/KYROllll/KYROlll-APP-/releases/latest/download/KYROlll-SOUL-1.3.0-mac.zip` |
| KYROlll SOUL Windows | `https://github.com/KYROllll/KYROlll-APP-/releases/latest/download/KYROlll-SOUL-1.3.0-win.zip` |

The plugin entries ship with `sha256: null` and `size: null` until the real
plugin archives are uploaded. Null checksums are skipped by the installer; fill
in both fields from the uploaded archives for verified downloads. The app
entries already contain the checksums and sizes of the current macOS and
Windows builds.

When publishing a new version, bump `app.latestVersion` and/or the plugin
`version`, rebuild and upload matching assets, then update checksums and sizes
in `catalog.json`. A newer catalog version automatically becomes an **Update
Available** state in the app.

## App update check

- The latest app version comes from `app.latestVersion` in the catalog, or from
  `KYROLLL_RELEASE_FEED_URL` when configured. The higher version wins.
- The renderer compares it to `app.getVersion()` and, when newer, shows a
  high-contrast update banner, a toast notification, the app changelog, and a
  **Download Update** button that opens the platform installer URL.
- **KYROlll → Check for Updates…** in the menu forces a check and offers the
  download as well.

## Run locally

```bash
npm install
npm start            # production-style launch
npm run dev          # same, with DevTools open
```

The app opens with the built-in demo catalog, so it works with no network and no
configuration. Click **Install** on KYROlll SOUL to exercise the full pipeline.

### Regenerate the app icon

```bash
npm run icon         # renders build/icon.svg -> build/icon.png (1024x1024)
```

### Regenerate demo archives

```bash
npm run demo:archive # rebuilds resources/demo/*.zip from catalog.fallback.json
```

## Test & verify

```bash
npm test             # build config + install smoke + update/uninstall smoke
npm run smoke:ui     # boots the real window and asserts update/banner UI
```

`smoke-update` uses an isolated temp state, a file:// catalog fixture and a
GitHub-style release feed. It asserts live refresh, checksum/size verification,
install, update detection (`1.3.0 → 1.4.0`), app update detection, Windows bundle
filtering and clean uninstall. `smoke:ui` asserts the update badge, version
delta, remove control, app update banner and platform-aware footer (and uses its
own userData folder so it will not collide with a running KYROlll install).

### Point at a different catalog / release feed

```bash
KYROLLL_CATALOG_URL=https://raw.githubusercontent.com/you/hub-catalog/main/catalog.json \
KYROLLL_RELEASE_FEED_URL=https://api.github.com/repos/you/kyrolll/releases/latest \
npm start
```

### Isolate all filesystem writes

```bash
KYROLLL_STATE_DIR=/tmp/kyrolll-state \
KYROLLL_COMPONENTS_DIR=/tmp/kyrolll-au \
KYROLLL_VST3_DIR=/tmp/kyrolll-vst3 \
npm start
```

## Packaging

Electron Builder is configured with **both** macOS and Windows targets in
`package.json`:

```bash
npm run dist         # macOS: release/*.dmg + *.zip
npm run dist:mac     # explicit macOS
npm run dist:win     # Windows: NSIS installer (*.exe) + portable zip
npm run dist:all     # macOS + Windows in one run
npm run verify:build # static validation of targets, paths, catalog and icons
```

Windows targets:

- **NSIS** (x64) — assisted installer, install-directory choice, desktop and
  Start Menu shortcuts.
- **ZIP** (x64) — portable unpacked build.

`npm run verify:build` works on any host. Building the NSIS installer from a
non-Windows host may require Wine (electron-builder's Windows resource editing);
building on Windows is fully native.

`npm run icon` must have run first so `build/icon.png` exists.

## Visual identity

- Brand marks: the flower from the supplied artwork, plus the white wordmark
  traced from `KYROlll 0001.tiff` into `src/assets/kyrolll-wordmark.svg`. Every
  visible brand mention uses that graphic.
- Palette: matte black, white and silver, separated by hairline rules. The
  update state adds a bright hairline and white update badge without changing
  the palette.
- Typography: a technical mono for display, prose, labels, metadata and status
  text, tracked and uppercase to match the store.
- Catalog: bundled locally by default. A remote request is made automatically
  when `KYROLLL_CATALOG_URL` / `catalogUrl` is configured.
- Title bar uses `hiddenInset` on macOS so traffic lights sit inside the app
  chrome; Windows uses the native frame with no macOS gutter.
