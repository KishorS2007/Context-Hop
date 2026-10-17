// Dev-only script: generates extension PNG icons (16, 32, 48, 128)
// Run with: node extension/assets/generate_icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

function createPNG(width, height, getPixel) {
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const pxOffset = rowOffset + 1 + x * 4;
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a;
    }
  }

  const deflated = zlib.deflateSync(raw);

  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  function crc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    return (crc ^ (-1)) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    header,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distRoundRect(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x - cx) - (w / 2 - r);
  const dy = Math.abs(y - cy) - (h / 2 - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function distCapsule(x, y, x1, y1, x2, y2, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = ((x - x1) * dx + (y - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return Math.sqrt((x - px) * (x - px) + (y - py) * (y - py)) - radius;
}

function renderBatonIcon(size) {
  const cx = size / 2;
  const cy = size / 2;
  const boxW = size * 0.88;
  const boxH = size * 0.88;
  const boxR = size * 0.22;

  const batonLen = size * 0.38;
  const batonRadius = Math.max(1.2, size * 0.08);
  const cos45 = Math.cos(Math.PI / 4);
  const sin45 = Math.sin(Math.PI / 4);

  const x1 = cx - batonLen * 0.5 * cos45;
  const y1 = cy + batonLen * 0.5 * sin45;
  const x2 = cx + batonLen * 0.5 * cos45;
  const y2 = cy - batonLen * 0.5 * sin45;

  return createPNG(size, size, (x, y) => {
    let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
    const samples = 3;
    for (let sy = 0; sy < samples; sy++) {
      for (let sx = 0; sx < samples; sx++) {
        const px = x + (sx + 0.5) / samples;
        const py = y + (sy + 0.5) / samples;

        const dBox = distRoundRect(px, py, cx, cy, boxW, boxH, boxR);
        const dBaton = distCapsule(px, py, x1, y1, x2, y2, batonRadius);

        let r = 0, g = 0, b = 0, a = 0;

        if (dBox <= 0) {
          const isBorder = dBox > -Math.max(1, size * 0.04);
          if (isBorder) {
            r = 0x26; g = 0x38; b = 0x5A; a = 1;
          } else {
            r = 0x11; g = 0x1B; b = 0x2E; a = 1;
          }

          if (dBaton <= 0) {
            r = 0xFF; g = 0xC8; b = 0x3D; a = 1;
          } else if (dBaton < 1) {
            const t = 1 - dBaton;
            r = Math.round(r * (1 - t) + 0xFF * t);
            g = Math.round(g * (1 - t) + 0xC8 * t);
            b = Math.round(b * (1 - t) + 0x3D * t);
          }
        } else if (dBox < 1) {
          const t = 1 - dBox;
          r = 0x26; g = 0x38; b = 0x5A; a = t;
        }

        rSum += r; gSum += g; bSum += b; aSum += a;
      }
    }
    const total = samples * samples;
    return [
      Math.round(rSum / total),
      Math.round(gSum / total),
      Math.round(bSum / total),
      Math.round((aSum / total) * 255),
    ];
  });
}

for (const s of [16, 32, 48, 128]) {
  const png = renderBatonIcon(s);
  const p = path.join(iconsDir, 'icon' + s + '.png');
  fs.writeFileSync(p, png);
  console.log('Saved ' + p);
}
