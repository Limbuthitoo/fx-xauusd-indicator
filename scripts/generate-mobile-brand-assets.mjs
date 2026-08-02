import { PNG } from "pngjs";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve("apps/mobile/assets");

const colors = {
  bg: [5, 7, 6, 255],
  panel: [17, 20, 18, 255],
  panel2: [26, 31, 28, 255],
  green: [47, 230, 168, 255],
  greenDark: [12, 112, 78, 255],
  gold: [240, 201, 74, 255],
  white: [244, 247, 244, 255],
  muted: [130, 140, 134, 255],
  transparent: [0, 0, 0, 0]
};

function makePng(width, height, fill = colors.transparent) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(png, x, y, fill);
  }
  return png;
}

function setPixel(png, x, y, color) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  png.data[idx] = color[0];
  png.data[idx + 1] = color[1];
  png.data[idx + 2] = color[2];
  png.data[idx + 3] = color[3];
}

function blendPixel(png, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  const sourceAlpha = (color[3] / 255) * alpha;
  const destAlpha = png.data[idx + 3] / 255;
  const outAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
  if (outAlpha <= 0) return;
  for (let i = 0; i < 3; i += 1) {
    png.data[idx + i] = Math.round((color[i] * sourceAlpha + png.data[idx + i] * destAlpha * (1 - sourceAlpha)) / outAlpha);
  }
  png.data[idx + 3] = Math.round(outAlpha * 255);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t)
  ];
}

function roundedRect(png, x, y, width, height, radius, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      const dx = px < x + radius ? x + radius - px : px > x + width - radius ? px - (x + width - radius) : 0;
      const dy = py < y + radius ? y + radius - py : py > y + height - radius ? py - (y + height - radius) : 0;
      if (dx * dx + dy * dy <= radius * radius) setPixel(png, px, py, color);
    }
  }
}

function circle(png, cx, cy, radius, color, alpha = 1) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 <= r2) blendPixel(png, x, y, color, alpha);
    }
  }
}

function line(png, x1, y1, x2, y2, width, color, alpha = 1) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    circle(png, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color, alpha);
  }
}

function quadratic(png, x1, y1, cx, cy, x2, y2, width, color) {
  let prevX = x1;
  let prevY = y1;
  for (let i = 1; i <= 90; i += 1) {
    const t = i / 90;
    const x = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
    const y = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
    line(png, prevX, prevY, x, y, width, color);
    prevX = x;
    prevY = y;
  }
}

function gradientBackground(png) {
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const vertical = y / png.height;
      const radial = Math.max(0, 1 - Math.hypot(x / png.width - 0.52, y / png.height - 0.28) * 1.7);
      const base = mix(colors.bg, colors.panel2, Math.min(1, vertical * 0.45 + radial * 0.35));
      setPixel(png, x, y, base);
    }
  }
}

function drawBullFxMark(png, cx, cy, scale = 1, showRing = true) {
  if (showRing) {
    circle(png, cx, cy, 260 * scale, [47, 230, 168, 28], 1);
    circle(png, cx, cy, 212 * scale, [240, 201, 74, 22], 1);
  }

  roundedRect(png, cx - 142 * scale, cy - 8 * scale, 284 * scale, 154 * scale, 72 * scale, colors.panel2);
  quadratic(png, cx - 132 * scale, cy + 20 * scale, cx - 250 * scale, cy - 190 * scale, cx - 360 * scale, cy - 88 * scale, 42 * scale, colors.gold);
  quadratic(png, cx + 132 * scale, cy + 20 * scale, cx + 250 * scale, cy - 190 * scale, cx + 360 * scale, cy - 88 * scale, 42 * scale, colors.gold);
  quadratic(png, cx - 118 * scale, cy + 26 * scale, cx - 225 * scale, cy - 128 * scale, cx - 316 * scale, cy - 70 * scale, 18 * scale, colors.bg);
  quadratic(png, cx + 118 * scale, cy + 26 * scale, cx + 225 * scale, cy - 128 * scale, cx + 316 * scale, cy - 70 * scale, 18 * scale, colors.bg);

  line(png, cx - 62 * scale, cy - 28 * scale, cx - 62 * scale, cy + 118 * scale, 26 * scale, colors.green);
  roundedRect(png, cx - 104 * scale, cy + 18 * scale, 84 * scale, 58 * scale, 16 * scale, colors.green);
  line(png, cx + 68 * scale, cy - 82 * scale, cx + 68 * scale, cy + 86 * scale, 22 * scale, colors.gold);
  roundedRect(png, cx + 30 * scale, cy - 16 * scale, 76 * scale, 62 * scale, 16 * scale, colors.gold);
  line(png, cx - 182 * scale, cy + 104 * scale, cx - 90 * scale, cy + 104 * scale, 20 * scale, colors.white);
  line(png, cx + 90 * scale, cy + 104 * scale, cx + 182 * scale, cy + 104 * scale, 20 * scale, colors.white);
}

function drawWordMark(png, x, y, scale = 1) {
  // Pixel-style compact lettering keeps the logo dependency-free while still readable at mobile sizes.
  const letters = [
    ["X", [[0, 0, 4, 4], [4, 0, 0, 4]]],
    ["A", [[0, 4, 2, 0], [2, 0, 4, 4], [1, 2, 3, 2]]],
    ["U", [[0, 0, 0, 4], [4, 0, 4, 4], [0, 4, 4, 4]]],
    ["S", [[4, 0, 0, 0], [0, 0, 0, 2], [0, 2, 4, 2], [4, 2, 4, 4], [4, 4, 0, 4]]],
    ["D", [[0, 0, 0, 4], [0, 0, 3, 0], [3, 0, 4, 1], [4, 1, 4, 3], [4, 3, 3, 4], [3, 4, 0, 4]]]
  ];
  let cursor = x;
  for (const [, segments] of letters) {
    for (const [x1, y1, x2, y2] of segments) {
      line(png, cursor + x1 * 16 * scale, y + y1 * 16 * scale, cursor + x2 * 16 * scale, y + y2 * 16 * scale, 9 * scale, colors.white);
    }
    cursor += 88 * scale;
  }
  line(png, cursor + 8 * scale, y + 32 * scale, cursor + 120 * scale, y + 32 * scale, 8 * scale, colors.green);
  line(png, cursor + 32 * scale, y + 10 * scale, cursor + 32 * scale, y + 54 * scale, 8 * scale, colors.green);
  line(png, cursor + 78 * scale, y, cursor + 78 * scale, y + 64 * scale, 8 * scale, colors.gold);
}

async function writePng(name, png) {
  const file = resolve(root, name);
  mkdirSync(dirname(file), { recursive: true });
  await new Promise((resolveWrite) => png.pack().pipe(createWriteStream(file)).on("finish", resolveWrite));
}

async function main() {
  mkdirSync(root, { recursive: true });

  const icon = makePng(1024, 1024, colors.bg);
  gradientBackground(icon);
  roundedRect(icon, 62, 62, 900, 900, 210, [16, 20, 18, 255]);
  roundedRect(icon, 96, 96, 832, 832, 184, [9, 13, 11, 255]);
  drawBullFxMark(icon, 512, 505, 1.05, true);
  await writePng("icon.png", icon);

  const adaptive = makePng(1024, 1024, colors.transparent);
  drawBullFxMark(adaptive, 512, 512, 1.08, false);
  await writePng("adaptive-icon.png", adaptive);

  const splash = makePng(1242, 2436, colors.bg);
  gradientBackground(splash);
  drawBullFxMark(splash, 621, 930, 0.72, true);
  drawWordMark(splash, 342, 1210, 0.74);
  line(splash, 440, 1336, 802, 1336, 4, [47, 230, 168, 180]);
  await writePng("splash.png", splash);

  const logo = makePng(920, 260, colors.transparent);
  drawBullFxMark(logo, 136, 130, 0.28, false);
  drawWordMark(logo, 285, 72, 0.78);
  line(logo, 286, 174, 762, 174, 4, [47, 230, 168, 180]);
  await writePng("brand-logo.png", logo);

  const mark = makePng(256, 256, colors.transparent);
  drawBullFxMark(mark, 128, 128, 0.26, false);
  await writePng("brand-mark.png", mark);
}

await main();
