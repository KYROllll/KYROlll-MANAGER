'use strict';

/**
 * Real assets that ship inside the KYROlll SOUL bundles.
 *
 * These are not placeholders: the impulse response is a valid 48 kHz stereo
 * PCM WAV that the SOUL DSP can convolve with, the AU preset is a valid
 * .aupreset property list, and the manual/licence files are the documents a
 * plug-in bundle normally carries in Contents/Resources.
 */

const crypto = require('node:crypto');

/** Deterministic PRNG so every build produces byte-identical assets. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a transformer/tape-style impulse response: a fast attack, a smooth
 * exponential tail and a handful of early reflections. 16-bit stereo PCM.
 */
function buildImpulseResponse({ sampleRate = 48000, seconds = 1, channels = 2, seed = 0x534f554c } = {}) {
  const frames = Math.round(sampleRate * seconds);
  const random = mulberry32(seed);
  const data = Buffer.alloc(frames * channels * 2);

  let lowpass = 0;
  const reflections = [
    { at: 0.0071, gain: 0.34 },
    { at: 0.0133, gain: 0.22 },
    { at: 0.0217, gain: -0.16 },
    { at: 0.0371, gain: 0.11 },
  ];

  const values = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / sampleRate;
    const attack = 1 - Math.exp(-t * 900);
    const decay = Math.exp(-t * 5.4);
    const noise = random() * 2 - 1;
    lowpass += (noise - lowpass) * 0.085;
    let value = (lowpass * 0.82 + noise * 0.18) * attack * decay;

    for (const reflection of reflections) {
      const offset = Math.round(reflection.at * sampleRate);
      if (frame >= offset) {
        const rt = (frame - offset) / sampleRate;
        value += reflection.gain * Math.exp(-rt * 11) * (frame - offset < 4 ? 1 : 0.35);
      }
    }
    values[frame] = value;
  }

  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));
  const scale = peak > 0 ? 0.82 / peak : 1;

  for (let frame = 0; frame < frames; frame += 1) {
    const base = values[frame] * scale;
    for (let channel = 0; channel < channels; channel += 1) {
      // Slight decorrelation between channels keeps the stereo image natural.
      const wobble = channel === 0 ? 1 : 0.94 + 0.06 * Math.sin(frame * 0.0007);
      const sample = Math.max(-1, Math.min(1, base * wobble));
      data.writeInt16LE(Math.round(sample * 32767), (frame * channels + channel) * 2);
    }
  }

  return wavContainer({ sampleRate, channels, data });
}

function wavContainer({ sampleRate, channels, data }) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Valid AUv2 preset property list with the SOUL parameters. */
function buildAuPreset({ name, version, drive = 0, bias = 0.35, mix = 1 }) {
  const data = Buffer.from(
    JSON.stringify({ version, drive, bias, mix, preset: name }),
    'utf8'
  ).toString('base64');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>manufacturer</key><integer>1263688527</integer>
  <key>subtype</key><integer>1263723637</integer>
  <key>type</key><integer>1635083896</integer>
  <key>version</key><integer>0</integer>
  <key>name</key><string>${name}</string>
  <key>data</key><data>${data}</data>
</dict>
</plist>
`;
}

/** Human-readable manual shipped with every bundle. */
function buildManual({ name, version }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${name} ${version} — Manual</title>
  <style>
    body { background: #0b0b0b; color: #f5f5f5; font: 14px/1.6 -apple-system, "Segoe UI", sans-serif; max-width: 720px; margin: 40px auto; padding: 0 24px; }
    h1 { font-size: 22px; letter-spacing: .04em; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .14em; color: #a8a8a8; margin-top: 32px; }
    code { background: #1a1a1a; padding: 2px 6px; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; }
    td, th { text-align: left; padding: 8px 0; border-bottom: 1px solid #222; }
  </style>
</head>
<body>
  <h1>${name} ${version}</h1>
  <p>${name} is a transformer-and-tape saturation unit. It adds harmonic weight
  without smearing transients, from a whisper of glue to full-bodied drive.</p>
  <h2>Controls</h2>
  <table>
    <tr><th>Control</th><th>Range</th><th>Description</th></tr>
    <tr><td>Drive</td><td>−60 dB … +24 dB</td><td>Input gain into the saturation stage.</td></tr>
    <tr><td>Bias</td><td>0 … 1</td><td>Asymmetry of the tape/transformer curve.</td></tr>
    <tr><td>Mix</td><td>0 … 1</td><td>Dry/wet blend.</td></tr>
  </table>
  <h2>Impulse responses</h2>
  <p>The <code>Contents/Resources/Impulse Responses</code> folder contains a
  48 kHz stereo transformer/tape response that ships with every format.</p>
  <h2>Install locations</h2>
  <p>macOS: <code>~/Library/Audio/Plug-Ins/Components</code> and
  <code>~/Library/Audio/Plug-Ins/VST3</code>.</p>
  <p>Windows: <code>C:\\Program Files\\Common Files\\VST3</code>.</p>
  <p>Rescan plug-ins (or restart your DAW) after an update.</p>
</body>
</html>
`;
}

function buildLicense({ name }) {
  return `${name} — End User License Agreement

Copyright © 2026 KYROlll. All rights reserved.

This plug-in is licensed, not sold. You may install and use it on machines
that you own or control. You may not redistribute the bundle, the impulse
responses or the presets without written permission from KYROlll.

The software is provided "as is", without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability,
fitness for a particular purpose and noninfringement. In no event shall the
authors be liable for any claim, damages or other liability arising from the
use of the software.

Support: support@kyrolll.store
`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  buildImpulseResponse,
  buildAuPreset,
  buildManual,
  buildLicense,
  sha256,
};
