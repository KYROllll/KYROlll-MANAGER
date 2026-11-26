'use strict';

/**
 * Render the KYROlll MANAGER DMG background.
 *
 * The installer window is 660x420 pt with the app icon at (180, 200) and the
 * /Applications link at (480, 200). This draws a pure black plate, the
 * KYROlll wordmark, a white dotted arrow between the two icon slots and a
 * small caption, then writes:
 *   build/dmg-background.png     (660x420, 1x)
 *   build/dmg-background@2x.png  (1320x840, Retina)
 *
 * electron-builder combines the pair into a Retina TIFF via `tiffutil`, so the
 * black plate, arrow and wordmark stay crisp on Apple Silicon displays.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const WORDMARK_SVG = path.join(ROOT, 'src', 'assets', 'kyrolll-wordmark.svg');
const WORDMARK_PNG = path.join(ROOT, 'src', 'assets', 'kyrolll-wordmark.png');
const OUT = path.join(ROOT, 'build', 'dmg-background.png');

const WIDTH = 660;
const HEIGHT = 420;
const LEFT_X = 180;
const RIGHT_X = 480;
const ICON_Y = 200;
const ICON_SIZE = 128;

/** Load the wordmark as a data URI; prefer the vector asset for crisp type. */
function wordmarkSource() {
  if (fs.existsSync(WORDMARK_SVG)) {
    const svg = fs.readFileSync(WORDMARK_SVG, 'utf8');
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }
  return `data:image/png;base64,${fs.readFileSync(WORDMARK_PNG).toString('base64')}`;
}

function html(scale) {
  const wordmark = wordmarkSource();
  const px = (value) => `${value * scale}px`;
  const hairline = Math.max(1, Math.round(scale));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${px(WIDTH)}; height: ${px(HEIGHT)};
    background: #000000;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    color: #ffffff;
  }
  .plate { position: relative; width: ${px(WIDTH)}; height: ${px(HEIGHT)}; background: #000; }
  .wordmark {
    position: absolute; left: 50%; top: ${px(56)};
    width: ${px(240)}; height: auto;
    transform: translateX(-50%);
  }
  .rule {
    position: absolute; left: 50%; top: ${px(106)};
    width: ${px(300)}; height: ${hairline}px;
    transform: translateX(-50%);
    background: rgba(255, 255, 255, 0.16);
  }
  .arrow {
    position: absolute; top: ${px(ICON_Y - 2)};
    left: ${px(LEFT_X + ICON_SIZE / 2 + 20)};
    width: ${px(RIGHT_X - LEFT_X - ICON_SIZE - 40)};
    height: ${px(4)};
    background-image: linear-gradient(to right, #ffffff 55%, transparent 55%);
    background-size: ${px(16)} ${px(4)};
    background-repeat: repeat-x;
  }
  .arrow-head {
    position: absolute; top: ${px(ICON_Y - 9)};
    left: ${px(RIGHT_X - ICON_SIZE / 2 - 28)};
    width: ${px(16)}; height: ${px(16)};
    border-top: ${px(3)} solid #ffffff;
    border-right: ${px(3)} solid #ffffff;
    transform: rotate(45deg);
  }
  .caption {
    position: absolute; left: 50%; bottom: ${px(30)};
    transform: translateX(-50%);
    font-size: ${px(12)};
    letter-spacing: ${px(2.6)};
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.62);
    white-space: nowrap;
  }
</style>
</head>
<body>
  <div class="plate">
    <img class="wordmark" src="${wordmark}" alt="KYROlll" />
    <div class="rule"></div>
    <div class="arrow"></div>
    <div class="arrow-head"></div>
    <div class="caption">Drag to Applications to Install</div>
  </div>
</body>
</html>`;
}

async function capture(scale) {
  const width = WIDTH * scale;
  const height = HEIGHT * scale;
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(scale)));
  await new Promise((resolve) => setTimeout(resolve, 350));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  win.destroy();
  return image;
}

async function main() {
  await app.whenReady();

  // Render the plate at 2x CSS pixels. `capturePage` may already return a
  // higher device-pixel image on a Retina host, so normalise to exactly
  // 1320x840 before downscaling the 1x plate from it.
  const captured = await capture(2);
  const retina = captured.resize({ width: WIDTH * 2, height: HEIGHT * 2, quality: 'best' });
  const retinaSize = retina.getSize();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT.replace(/\.png$/, '@2x.png'), retina.toPNG());
  console.log(`wrote build/dmg-background@2x.png (${retinaSize.width}x${retinaSize.height})`);

  const standard = retina.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
  fs.writeFileSync(OUT, standard.toPNG());
  const size = standard.getSize();
  console.log(`wrote build/dmg-background.png (${size.width}x${size.height})`);

  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.quit();
  process.exitCode = 1;
});
