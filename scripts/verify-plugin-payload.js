'use strict';

/**
 * Structural verification of the shipped KYROlll SOUL payloads.
 *
 * Opens the real archives referenced by catalog.json and asserts that both
 * platforms contain genuine bundle layouts, not placeholder text:
 *
 *   macOS  : KYROlll SOUL.component + KYROlll SOUL.vst3, each with a universal
 *            Mach-O binary in Contents/MacOS and real resources (impulse
 *            response, presets, manual, licence, moduleinfo.json).
 *   Windows: KYROlll SOUL.vst3 with a PE32+ DLL in Contents/x86_64-win and the
 *            same real resources.
 *
 * Usage: npm run verify:payload
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const extractZip = require('extract-zip');

const ROOT = path.join(__dirname, '..');
const catalogPath = path.join(ROOT, 'catalog.json');
const fallbackPath = path.join(ROOT, 'resources', 'catalog.fallback.json');
const tempRoot = path.join(os.tmpdir(), `kyrolll-payload-verify-${process.pid}`);

const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function walk(root) {
  const files = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function readPlistValue(file, key) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`, 'i'));
  return match ? match[1].trim() : null;
}

function fileType(file) {
  try {
    return execFileSync('file', ['-b', file], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function exportedNames(file) {
  try {
    const output = execFileSync('objdump', ['-p', file], { encoding: 'utf8' });
    return output;
  } catch {
    return '';
  }
}

async function extract(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  await extractZip(archive, { dir: destination });
}

function findBundle(root, extension) {
  if (!fs.existsSync(root)) return null;
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith(extension)) return full;
      queue.push(full);
    }
  }
  return null;
}

function checkResources(bundle, label, { expectPresets }) {
  const resources = path.join(bundle, 'Contents', 'Resources');
  check(`${label} has Contents/Resources`, fs.existsSync(resources));
  if (!fs.existsSync(resources)) return;

  const files = walk(resources);
  const relative = files.map((file) => path.relative(resources, file));
  check(`${label} Resources contains real files`, files.length >= 3, `${files.length} files`);
  check(
    `${label} ships the 48 kHz impulse response`,
    relative.some((name) => /Impulse Responses\/SOUL Transformer 48k\.wav$/.test(name))
  );
  check(`${label} ships the manual`, relative.some((name) => /Documentation\/Manual\.html$/.test(name)));
  check(`${label} ships the licence`, relative.some((name) => /License\.txt$/.test(name)));
  if (expectPresets) {
    check(
      `${label} ships factory presets`,
      relative.filter((name) => name.endsWith('.aupreset')).length >= 2
    );
  }

  const wav = files.find((file) => file.endsWith('.wav'));
  if (wav) {
    const header = fs.readFileSync(wav).subarray(0, 12);
    check(`${label} impulse response is a WAV`, header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE');
    check(`${label} impulse response is substantial`, fs.statSync(wav).size > 100 * 1024, `${fs.statSync(wav).size} bytes`);
  }
}

async function checkMac(plugin, archive, version) {
  console.log(`macOS payload: ${path.basename(archive)}`);
  const dir = path.join(tempRoot, 'mac');
  await extract(archive, dir);

  const au = findBundle(dir, '.component');
  const vst3 = findBundle(dir, '.vst3');
  check('macOS archive contains an AU .component bundle', Boolean(au));
  check('macOS archive contains a VST3 .vst3 bundle', Boolean(vst3));

  if (au) {
    const binary = path.join(au, 'Contents', 'MacOS', path.basename(au, '.component'));
    check('AU bundle has Contents/MacOS binary', fs.existsSync(binary));
    if (fs.existsSync(binary)) {
      const type = fileType(binary);
      check('AU binary is a universal Mach-O', /Mach-O universal binary/.test(type) && /arm64/.test(type) && /x86_64/.test(type), type);
      check('AU binary is real code', fs.statSync(binary).size > 50 * 1024, `${fs.statSync(binary).size} bytes`);
    }
    const plist = path.join(au, 'Contents', 'Info.plist');
    check('AU Info.plist version matches catalog', readPlistValue(plist, 'CFBundleShortVersionString') === version);
    check('AU Info.plist registers AudioComponents', /<key>AudioComponents<\/key>/.test(fs.readFileSync(plist, 'utf8')));
    checkResources(au, 'AU', { expectPresets: true });
  }

  if (vst3) {
    const binary = path.join(vst3, 'Contents', 'MacOS', path.basename(vst3, '.vst3'));
    check('VST3 bundle has Contents/MacOS binary', fs.existsSync(binary));
    if (fs.existsSync(binary)) {
      const type = fileType(binary);
      check('VST3 binary is a universal Mach-O', /Mach-O universal binary/.test(type) && /arm64/.test(type) && /x86_64/.test(type), type);
      check('VST3 binary is real code', fs.statSync(binary).size > 50 * 1024, `${fs.statSync(binary).size} bytes`);
    }
    const moduleInfo = path.join(vst3, 'Contents', 'Resources', 'moduleinfo.json');
    check('VST3 moduleinfo.json exists', fs.existsSync(moduleInfo));
    if (fs.existsSync(moduleInfo)) {
      const info = JSON.parse(fs.readFileSync(moduleInfo, 'utf8'));
      check('VST3 moduleinfo version matches catalog', info.Version === version, info.Version);
      check('VST3 moduleinfo describes an Audio Module Class', info.Classes?.[0]?.Category === 'Audio Module Class');
    }
    checkResources(vst3, 'VST3', { expectPresets: false });
  }

  check('macOS archive is not a dummy', fs.statSync(archive).size > 100 * 1024, `${fs.statSync(archive).size} bytes`);
}

async function checkWindows(plugin, archive, version) {
  console.log(`Windows payload: ${path.basename(archive)}`);
  const dir = path.join(tempRoot, 'win');
  await extract(archive, dir);

  const vst3 = findBundle(dir, '.vst3');
  check('Windows archive contains a VST3 .vst3 bundle', Boolean(vst3));
  if (!vst3) return;

  const dll = path.join(vst3, 'Contents', 'x86_64-win', `${plugin.name}.vst3`);
  check('Windows bundle has Contents/x86_64-win binary', fs.existsSync(dll));
  if (fs.existsSync(dll)) {
    const data = fs.readFileSync(dll);
    check('Windows binary starts with MZ', data.toString('ascii', 0, 2) === 'MZ');
    const peOffset = data.readUInt32LE(0x3c);
    check('Windows binary has a PE signature', data.toString('binary', peOffset, peOffset + 4) === 'PE\0\0');
    check('Windows binary is PE32+ x86-64', data.readUInt16LE(peOffset + 4) === 0x8664 && data.readUInt16LE(peOffset + 24) === 0x20b);
    check('Windows binary declares DLL characteristics', (data.readUInt16LE(peOffset + 4 + 18) & 0x2000) !== 0);
    const exportsText = exportedNames(dll);
    for (const name of ['GetPluginFactory', 'InitDll', 'ExitDll']) {
      check(`Windows binary exports ${name}`, exportsText.includes(name) || data.includes(Buffer.from(name)));
    }
    const type = fileType(dll);
    check('Windows binary is recognized as a PE DLL', /PE32\+/.test(type) && /DLL/i.test(type), type);
    check('Windows binary is real code', data.length > 1024, `${data.length} bytes`);
  }

  const moduleInfo = path.join(vst3, 'Contents', 'Resources', 'moduleinfo.json');
  check('Windows moduleinfo.json exists', fs.existsSync(moduleInfo));
  if (fs.existsSync(moduleInfo)) {
    const info = JSON.parse(fs.readFileSync(moduleInfo, 'utf8'));
    check('Windows moduleinfo version matches catalog', info.Version === version, info.Version);
    check('Windows moduleinfo has a bundle id', typeof info.BundleId === 'string' && info.BundleId.length > 0);
    check('Windows moduleinfo describes an Audio Module Class', info.Classes?.[0]?.Category === 'Audio Module Class');
  }
  checkResources(vst3, 'Windows VST3', { expectPresets: false });
  check('Windows archive is not a dummy', fs.statSync(archive).size > 100 * 1024, `${fs.statSync(archive).size} bytes`);
}

async function main() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const fallback = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
    const plugin = catalog.plugins.find((entry) => entry.id === 'kyrolll-soul');
    check('catalog has KYROlll SOUL', Boolean(plugin));
    if (!plugin) return;

    const fallbackPlugin = fallback.plugins.find((entry) => entry.id === 'kyrolll-soul');
    check('fallback catalog version matches catalog.json', fallbackPlugin?.version === plugin.version);

    for (const [platform, label] of [
      ['mac', 'macOS'],
      ['win', 'Windows'],
    ]) {
      const download = plugin.downloads?.[platform];
      check(`${label} catalog download exists`, Boolean(download?.url));
      check(`${label} download has a checksum`, Boolean(download?.sha256));
      check(`${label} download has an app-managed fallback`, download?.fallbackUrl?.startsWith('app://plugins/'));
      const archive = path.join(ROOT, 'resources', 'plugins', path.basename(download?.fallbackUrl || download?.url || ''));
      check(`${label} archive is bundled`, fs.existsSync(archive), archive);
      if (!fs.existsSync(archive)) continue;
      check(`${label} archive size matches catalog`, fs.statSync(archive).size === download.size);
      check(`${label} archive filename matches catalog version`, path.basename(archive).includes(plugin.version));

      if (platform === 'mac') await checkMac(plugin, archive, plugin.version);
      else await checkWindows(plugin, archive, plugin.version);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\n${failures.length} payload check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nPLUGIN PAYLOAD OK');
  }
}

main().catch((err) => {
  console.error('PAYLOAD VERIFY FAIL:', err.stack || err.message);
  process.exitCode = 1;
});
