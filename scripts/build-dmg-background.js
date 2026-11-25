'use strict';

/**
 * Render the KYROlll MANAGER DMG background.
 *
 * The installer window is 660x420 pt with the app icon at (180, 200) and the
 * /Applications link at (480, 200). This draws a pure black plate, the
 * KYROlll wordmark, a white dotted arrow between the two icon slots and a
 * small caption, then writes build/dmg-background.png at 660x420.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const WORDMARK = path.join(ROOT, 'src', 'assets', 'kyrolll-wordmark.png');
const OUT = path.join(ROOT, 'build', 'dmg-background.png');

const WIDTH = 660;
const HEIGHT = 420;
const LEFT_X = 180;
const RIGHT_X = 480;
const ICON_Y = 200;
const ICON_SIZE = 128;

function html() {
  const wordmark = fs.readFileSync(WORDMARK).toString('base64');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${WIDTH}px; height: ${HEIGHT}px;
    background: #000000;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    color: #ffffff;
  }
  .plate { position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; background: #000; }
  .wordmark {
    position: absolute; left: 50%; top: 56px;
    width: 240px; height: auto;
    transform: translateX(-50%);
    image-rendering: -webkit-optimize-contrast;
  }
  .rule {
    position: absolute; left: 50%; top: 106px;
    width: 300px; height: 1px;
    transform: translateX(-50%);
    background: rgba(255, 255, 255, 0.16);
  }
  .arrow {
    position: absolute; top: ${ICON_Y - 2}px;
    left: ${LEFT_X + ICON_SIZE / 2 + 20}px;
    width: ${RIGHT_X - LEFT_X - ICON_SIZE - 40}px;
    height: 4px;
    background-image: linear-gradient(to right, #ffffff 55%, transparent 55%);
    background-size: 16px 4px;
    background-repeat: repeat-x;
  }
  .arrow-head {
    position: absolute; top: ${ICON_Y - 9}px;
    left: ${RIGHT_X - ICON_SIZE / 2 - 28}px;
    width: 16px; height: 16px;
    border-top: 3px solid #ffffff;
    border-right: 3px solid #ffffff;
    transform: rotate(45deg);
  }
  .caption {
    position: absolute; left: 50%; bottom: 30px;
    transform: translateX(-50%);
    font-size: 12px;
    letter-spacing: 2.6px;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.62);
    white-space: nowrap;
  }
</style>
</head>
<body>
  <div class="plate">
    <img class="wordmark" src="data:image/png;base64,${wordmark}" alt="" />
    <div class="rule"></div>
    <div class="arrow"></div>
    <div class="arrow-head"></div>
    <div class="caption">Drag to Applications to Install</div>
  </div>
</body>
</html>`;
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html()));
  await new Promise((resolve) => setTimeout(resolve, 350));

  let image = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  image = image.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  const { width, height } = image.getSize();
  console.log(`wrote ${path.relative(ROOT, OUT)} (${width}x${height})`);
  win.destroy();
  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.quit();
  process.exitCode = 1;
});
