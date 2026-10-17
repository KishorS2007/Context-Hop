// Dev-only script: generates extension PNG icons (16, 32, 48, 128)
// Run with: node extension/assets/generate_icons.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const assetsIconsDir = path.join(__dirname, 'icons');
const extIconsDir = path.resolve(__dirname, '../icons');

if (!fs.existsSync(assetsIconsDir)) fs.mkdirSync(assetsIconsDir, { recursive: true });
if (!fs.existsSync(extIconsDir)) fs.mkdirSync(extIconsDir, { recursive: true });

const logo16SvgPath = path.join(assetsIconsDir, 'logo-16.svg');
const logoTileSvgPath = path.join(assetsIconsDir, 'logo-tile.svg');

if (!fs.existsSync(logo16SvgPath) || !fs.existsSync(logoTileSvgPath)) {
  console.error('Missing logo-16.svg or logo-tile.svg in', assetsIconsDir);
  process.exit(1);
}

const logo16Svg = fs.readFileSync(logo16SvgPath, 'utf8');
const logoTileSvg = fs.readFileSync(logoTileSvgPath, 'utf8');

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Google Chrome executable not found. Existing PNG icons are retained.');
  process.exit(0);
}

const PORT = 9483;
const html = `<!DOCTYPE html>
<html>
<body>
<canvas id="c"></canvas>
<script>
async function svgToPng(svgStr, size) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function run() {
  const s16 = await svgToPng(${JSON.stringify(logo16Svg)}, 16);
  await fetch('/save', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ size: 16, data: s16 }) });

  const s32 = await svgToPng(${JSON.stringify(logoTileSvg)}, 32);
  await fetch('/save', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ size: 32, data: s32 }) });

  const s48 = await svgToPng(${JSON.stringify(logoTileSvg)}, 48);
  await fetch('/save', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ size: 48, data: s48 }) });

  const s128 = await svgToPng(${JSON.stringify(logoTileSvg)}, 128);
  await fetch('/save', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ size: 128, data: s128 }) });

  await fetch('/done');
}
run();
</script>
</body>
</html>`;

let chromeProc = null;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else if (req.url === '/save' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { size, data } = JSON.parse(body);
      const base64 = data.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      fs.writeFileSync(path.join(assetsIconsDir, `icon${size}.png`), buf);
      fs.writeFileSync(path.join(extIconsDir, `icon${size}.png`), buf);
      console.log(`Saved icon${size}.png`);
      res.writeHead(200);
      res.end('ok');
    });
  } else if (req.url === '/done') {
    res.writeHead(200);
    res.end('ok');
    setTimeout(() => {
      server.close();
      if (chromeProc) chromeProc.kill();
      process.exit(0);
    }, 500);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  chromeProc = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `http://127.0.0.1:${PORT}`
  ]);
  chromeProc.on('error', (err) => {
    console.error('Failed to spawn Chrome:', err);
    process.exit(1);
  });
});
