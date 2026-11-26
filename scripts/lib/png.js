'use strict';

/**
 * Minimal PNG reader for the DMG background checks.
 *
 * Supports the subset electron writes from `nativeImage.toPNG()`: 8-bit
 * truecolour (RGB) or truecolour-with-alpha (RGBA), non-interlaced. That is
 * all we need to assert the installer plate is pure black and the artwork is
 * present, and it keeps `npm run verify:build` dependency-free on every host.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readPng(file) {
  const buffer = fs.readFileSync(file);
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error(`${file} is not a PNG`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }

    offset = end + 4; // skip CRC
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`${file}: unsupported PNG (depth ${bitDepth}, colour ${colorType}, interlace ${interlace})`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const left = x >= channels ? pixels[dst + x - channels] : 0;
      const up = y > 0 ? pixels[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[dst - stride + x - channels] : 0;
      let out;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + Math.floor((left + up) / 2);
          break;
        case 4:
          out = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`${file}: unknown filter ${filter} on row ${y}`);
      }
      pixels[dst + x] = out & 0xff;
    }
  }

  function pixel(x, y) {
    const index = y * stride + x * channels;
    return [pixels[index], pixels[index + 1], pixels[index + 2]];
  }

  return { width, height, channels, pixel };
}

module.exports = { readPng };
