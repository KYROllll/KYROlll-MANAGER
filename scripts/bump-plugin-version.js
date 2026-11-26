'use strict';

/**
 * Publish a new KYROlll SOUL version.
 *
 * Usage:
 *   npm run plugin:release -- 1.4.0
 *
 * Bumps the version in catalog.json and the bundled fallback catalog, then
 * rebuilds the real macOS/Windows payloads (which also refreshes the download
 * URLs, sizes and SHA-256 checksums). Commit and push the resulting catalog
 * and resources to main; installed KYROlll MANAGER apps pick the new version
 * up on their next catalog refresh.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const version = String(process.argv[2] || '').trim();

if (!/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: npm run plugin:release -- <version>   e.g. npm run plugin:release -- 1.4.0');
  process.exit(1);
}

const catalogPath = path.join(ROOT, 'catalog.json');
const fallbackPath = path.join(ROOT, 'resources', 'catalog.fallback.json');
const today = new Date().toISOString().slice(0, 10);

for (const file of [catalogPath, fallbackPath]) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const plugin = data.plugins.find((entry) => entry.id === 'kyrolll-soul');
  if (!plugin) throw new Error(`KYROlll SOUL is missing from ${path.relative(ROOT, file)}`);
  plugin.version = version;
  plugin.releasedAt = today;
  data.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`bumped ${path.relative(ROOT, file)} → ${version}`);
}

console.log('rebuilding payloads…');
execFileSync(process.execPath, [path.join(__dirname, 'build-plugin-payload.js')], { stdio: 'inherit' });

console.log(`
Next steps:
  1. npm run verify:payload
  2. git add catalog.json resources/catalog.fallback.json resources/plugins resources/demo
  3. git commit -m "Publish KYROlll SOUL ${version}"
  4. git push origin main

Installed apps see the new version on their next catalog refresh and update
the AU/VST3 bundles in the OS plug-in folders in place.
`);
