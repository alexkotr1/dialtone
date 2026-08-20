/**
 * Build build/icon.ico from tools/icon.html.
 *
 * Run with Electron, not node — it uses nativeImage for the resizing, and
 * rendering the icon in the same engine that draws the app means the shortcut
 * icon and the app's own artwork cannot drift apart.
 *
 *   node_modules\electron\dist\electron.exe tools/make-icon.js
 *
 * The .ico container is assembled here rather than shelling out to
 * ImageMagick, which is not installed and would be a heavy dependency for
 * ~30 lines of header writing.
 */

'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Windows picks the closest size for each context: 16 in the title bar, 32 on
// the taskbar, 48 in Explorer, 256 for large tiles. Shipping only 256 makes
// the small ones look muddy, because the downscale happens at paint time.
const SIZES = [256, 128, 64, 48, 32, 16];

/**
 * Assemble PNGs into an ICO.
 *
 * ICO is a 6-byte header, then one 16-byte directory entry per image, then
 * the image data. Windows has accepted PNG-compressed entries since Vista, so
 * the PNGs go in verbatim — no BMP conversion, no mask plane.
 */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;

  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    // 256 is stored as 0: the field is one byte and 256 does not fit.
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette size, 0 for truecolour
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    // Transparent so the rounded corners are actually cut out rather than
    // filled with whatever the window background happened to be.
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });

  await win.loadFile(path.join(__dirname, 'icon.html'));
  // Let the gradient and the SVG paint before the shutter.
  await new Promise((r) => setTimeout(r, 400));

  const shot = await win.webContents.capturePage();
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });

  // Keep the master PNG too — useful for anything that wants a real image
  // rather than an icon resource.
  fs.writeFileSync(path.join(outDir, 'icon.png'), shot.toPNG());

  const pngs = SIZES.map((size) => ({
    size,
    data: nativeImage
      .createFromBuffer(shot.toPNG())
      .resize({ width: size, height: size, quality: 'best' })
      .toPNG(),
  }));

  const ico = buildIco(pngs);
  const icoPath = path.join(outDir, 'icon.ico');
  fs.writeFileSync(icoPath, ico);

  const alpha = shot.toBitmap().some((_b, i) => i % 4 === 3 && shot.toBitmap()[i] < 255);
  console.log(`wrote ${icoPath} (${ico.length} bytes, ${SIZES.length} sizes)`);
  console.log(`transparency: ${alpha ? 'yes — corners are cut out' : 'NO — corners are opaque'}`);

  app.exit(0);
});
