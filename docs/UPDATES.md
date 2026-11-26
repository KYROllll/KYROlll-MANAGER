# Publishing KYROlll MANAGER updates

KYROlll MANAGER has two independent update paths:

| What | Source of truth | Checked by |
| --- | --- | --- |
| **KYROlll SOUL plug-in** | `catalog.json` (`plugins[]`) | catalog refresh on launch, every 6 hours, or the refresh button |
| **KYROlll MANAGER app** | GitHub `releases/latest` (plus the catalog `app` block as a fallback) | release-feed check on launch, every 6 hours, or the refresh button |

Both paths surface an in-app banner/card and let the user finish the update
without leaving KYROlll MANAGER.

---

## 1. Publish a higher plug-in version

The current catalog ships **KYROlll SOUL 1.4.0**. To publish, for example,
1.5.0:

```bash
npm run plugin:release -- 1.5.0
npm run verify:payload
git add catalog.json resources/catalog.fallback.json resources/plugins resources/demo
git commit -m "Publish KYROlll SOUL 1.5.0"
git push origin main
```

`npm run plugin:release -- 1.5.0`:

1. bumps `plugins[0].version` in both `catalog.json` and
   `resources/catalog.fallback.json`,
2. rebuilds the real macOS and Windows packages
   (`resources/plugins/kyrolll-soul-1.5.0-{mac,win}.zip`),
3. refreshes each download's `size` and `sha256`,
4. points `url` at the versioned package on `raw.githubusercontent.com` and
   keeps `fallbackUrl` at the copy bundled inside the app,
5. refreshes `resources/demo/kyrolll-soul.zip` for offline installs.

### What the user sees

An app with 1.4.0 installed shows **UPDATE AVAILABLE** and
`v1.4.0 → v1.5.0` on the SOUL card. Clicking **Update** opens the install
sheet and visibly runs:

1. **Downloading archive** — real byte progress (`132 KB of 309 KB`, …),
   checksum and size verification.
2. **Extracting archive** — per-entry progress and a final
   `Extracted 34 files · 571 KB`.
3. **Installing AU & VST3 bundles** — `Placed KYROlll SOUL.component · AU`,
   `Placed KYROlll SOUL.vst3 · VST3`.
4. **Updating local state** — writes `installed.json`.
5. **Finished** — the sheet lists the exact OS destinations, e.g.
   `~/Library/Audio/Plug-Ins/Components/KYROlll SOUL.component`.

The old bundles are staged and swapped with a backup, so a failed update never
leaves a half-written plug-in behind. No staging/backup folders remain after a
successful run.

### Why the remote URL matters

The installed app may predate the new plug-in version, so its bundled
`app://plugins/…` archive is the old version. The catalog therefore uses a
versioned HTTPS URL as the primary source. Any installed KYROlll MANAGER can
download it and verify the SHA-256 checksum. The bundled `app://` archive is
used as an offline fallback when the HTTPS source is unavailable.

### Verify locally

```bash
npm run verify:payload       # real .component/.vst3/PE layouts, resources, versions
npm run smoke:plugin-update  # isolated 1.3.0 → 1.4.0 install + clean uninstall
npm run smoke:plugin-remote  # HTTP package download with byte progress
npm run smoke:live-update    # real OS folders: 1.3.0 → 1.4.0 (opt-in)
```

`smoke:live-update` uses the real
`~/Library/Audio/Plug-Ins/{Components,VST3}` folders and the real
`installed.json`. It is intentionally **not** part of `npm test`.

---

## 2. Publish a higher app version

The app version comes from `package.json`. The release feed is
`https://api.github.com/repos/KYROllll/KYROlll-MANAGER/releases/latest`.

1. Bump the app version:

   ```bash
   npm version 1.1.0 --no-git-tag-version
   ```

2. Build the three installers:

   ```bash
   npm run dist:all
   ```

   Outputs:

   - `release/KYROlll-MANAGER-1.1.0-arm64.dmg` (Apple Silicon)
   - `release/KYROlll-MANAGER-1.1.0-x64.dmg` (Intel)
   - `release/KYROlll-MANAGER-Setup-1.1.0.exe` (Windows)

3. Create a GitHub release tagged `v1.1.0` and attach those three files.

4. Update `catalog.json` / `resources/catalog.fallback.json`:

   - `app.latestVersion` → `1.1.0`
   - `app.releasedAt`, `app.releaseNotes`
   - `app.downloads.macArm64`, `macIntel`, `win` → the new asset names,
     `size` and `sha256`

   The app prefers the GitHub release feed when it is newer than the catalog,
   so the release is enough on its own; the catalog copy keeps offline starts
   and mirrored hosts working.

5. Commit and push:

   ```bash
   git add package.json package-lock.json catalog.json resources/catalog.fallback.json
   git commit -m "Release KYROlll MANAGER 1.1.0"
   git push origin main
   ```

### What the user sees

On the next check, KYROlll MANAGER shows the app-update banner with
`v1.0.0 → v1.1.0` and the release notes. Clicking **Download Update (DMG)**
streams the installer inside the app with a percentage and MB counter, then
verifies its size/checksum. The primary button becomes **Install Update**
(opens the downloaded installer) and a **Show Installer** action reveals it in
Finder.

### Verify locally

```bash
npm run smoke:app-release   # GitHub releases/latest-shaped feed + in-app download
npm run smoke:app-download  # catalog-driven app update + in-app download
npm run smoke:ui            # banner, plug-in update card, platform labels
```

`smoke:app-release` serves a `releases/latest` payload with `tag_name`,
`assets[].browser_download_url` and release notes, and proves that the feed
version wins over the older catalog version and that the installer lands in
the downloads folder.

---

## Payload layout

Both packages are real bundles, not placeholders.

macOS (`kyrolll-soul-<version>-mac.zip`):

```
KYROlll SOUL.component/Contents/MacOS/KYROlll SOUL          universal Mach-O (arm64 + x86_64)
KYROlll SOUL.component/Contents/Resources/
  Impulse Responses/SOUL Transformer 48k.wav                 real 48 kHz stereo PCM WAV
  Presets/KYROlll SOUL Default.aupreset
  Presets/KYROlll SOUL Warm.aupreset
  Documentation/Manual.html
  License.txt
KYROlll SOUL.vst3/Contents/MacOS/KYROlll SOUL                universal Mach-O
KYROlll SOUL.vst3/Contents/Resources/moduleinfo.json
KYROlll SOUL.vst3/Contents/Resources/…                      same real resources
```

Windows (`kyrolll-soul-<version>-win.zip`):

```
KYROlll SOUL.vst3/Contents/x86_64-win/KYROlll SOUL.vst3     real PE32+ DLL
  exports: GetPluginFactory, InitDll, ExitDll
KYROlll SOUL.vst3/Contents/Resources/moduleinfo.json
KYROlll SOUL.vst3/Contents/Resources/…                      same real resources
```

`npm run verify:payload` checks the PE header, exports, Mach-O architectures,
bundle versions and the real resource files on every run.
