#!/usr/bin/env node
/**
 * public/ 以下にPWA・iOSホーム画面用のアイコンPNGを生成するスクリプト。
 *
 * 依存ライブラリを増やさない方針のため、Node標準の `node:zlib` のみでPNGを自前エンコードする
 * （8bit RGBA・フィルタなし・zlib圧縮）。図案もCanvas等を使わず、ピクセル単位の数式判定で
 * 「トマト色の丸角背景＋シンプルなトマト図案（実+ヘタ+ハイライト）」を描画する。
 *
 * iOSのapple-touch-iconは透過pngだと透明部分が黒く表示されるため、本スクリプトが生成する
 * 画像はすべて不透明（alpha=255固定）にする。角丸の「外側」も透過にはせず、背景色(BG)で
 * 塗りつぶすことで対応する。
 *
 * 実行: node scripts/gen-icons.mjs（package.jsonにコマンドは追加していない。手動再生成用）。
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---- 最小限のPNGエンコーダ ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** width x height の8bit RGBAピクセルバッファ（フィルタ無しraw）をPNGバイト列にエンコードする。 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = chunk('IHDR', ihdrData);

  // 各スキャンラインの先頭にフィルタタイプ0(None)を付与してから連結する。
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const idat = chunk('IDAT', deflateSync(raw, { level: 9 }));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

// ---- 図案描画 ----

function hex(hexStr) {
  const n = parseInt(hexStr.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function mix(c1, c2, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return [0, 1, 2].map((i) => Math.round(c1[i] + (c2[i] - c1[i]) * clamped));
}

// マニフェスト(vite.config.ts)のbackground_color / theme_colorと合わせる。
const BG = hex('#fff7f5');
const TOMATO = hex('#e0473f');
const TOMATO_DARK = hex('#a8322b');
const TOMATO_LIGHT = hex('#ff7a68');
const LEAF = hex('#4c9a4c');
const LEAF_DARK = hex('#2f6b30');
const WHITE = [255, 255, 255];

/**
 * トマト色の丸角背景＋シンプルなトマト図案を size x size のRGBAピクセルバッファとして描画する。
 * 透過は一切使わない（iOSのapple-touch-iconで透明部が黒く表示される問題を避けるため）。
 */
function drawTomatoIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const setPixel = (x, y, rgb) => {
    const i = (y * size + x) * 4;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
    buf[i + 3] = 255; // 常に不透明
  };

  const cornerRadius = size * 0.2; // 丸角の半径（iOSアイコンの角丸に近い比率）
  const cx = size / 2;
  const cy = size * 0.56;
  const bodyR = size * 0.33;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // --- 丸角背景の判定: 四隅の角丸の外側だけBG、それ以外はTOMATO ---
      let insideRoundedSquare = true;
      const inCornerBoxX = x < cornerRadius || x >= size - cornerRadius;
      const inCornerBoxY = y < cornerRadius || y >= size - cornerRadius;
      if (inCornerBoxX && inCornerBoxY) {
        const nearX = x < cornerRadius ? cornerRadius : size - cornerRadius;
        const nearY = y < cornerRadius ? cornerRadius : size - cornerRadius;
        const dx = x - nearX + 0.5;
        const dy = y - nearY + 0.5;
        if (dx * dx + dy * dy > cornerRadius * cornerRadius) {
          insideRoundedSquare = false;
        }
      }

      if (!insideRoundedSquare) {
        setPixel(x, y, BG);
        continue;
      }

      let rgb = TOMATO;

      // --- トマトの実（円、中心が少し暗くなるグラデーション） ---
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= bodyR) {
        const t = dist / bodyR;
        rgb = mix(TOMATO_LIGHT, TOMATO_DARK, t * t);

        // ハイライト（左上のツヤ）
        const hx = x + 0.5 - (cx - bodyR * 0.35);
        const hy = y + 0.5 - (cy - bodyR * 0.42);
        const hDist = Math.sqrt(hx * hx + hy * hy);
        const hR = bodyR * 0.3;
        if (hDist < hR) {
          rgb = mix(rgb, WHITE, (1 - hDist / hR) * 0.4);
        }

        // --- ヘタ（葉）: 上部に3枚を扇状に配置。実の内側にだけ重ねて自然な輪郭にする ---
        const leafBaseX = cx;
        const leafBaseY = cy - bodyR * 0.55;
        for (const angleDeg of [-48, 0, 48]) {
          const angle = (angleDeg * Math.PI) / 180;
          const leafLen = bodyR * 0.66;
          const leafWidth = bodyR * 0.24;
          const tipX = leafBaseX + Math.sin(angle) * leafLen;
          const tipY = leafBaseY - Math.cos(angle) * leafLen;
          const vx = tipX - leafBaseX;
          const vy = tipY - leafBaseY;
          const len2 = vx * vx + vy * vy;
          const wx = x + 0.5 - leafBaseX;
          const wy = y + 0.5 - leafBaseY;
          const t2 = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
          const projX = leafBaseX + vx * t2;
          const projY = leafBaseY + vy * t2;
          const perpDist = Math.hypot(x + 0.5 - projX, y + 0.5 - projY);
          const widthAtT = leafWidth * Math.sin(Math.PI * Math.max(0.05, t2));
          if (perpDist < widthAtT && projY <= leafBaseY + leafWidth) {
            rgb = mix(LEAF, LEAF_DARK, t2);
          }
        }
      }

      setPixel(x, y, rgb);
    }
  }

  return buf;
}

const TARGETS = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'pwa-192.png', size: 192 },
  { file: 'pwa-512.png', size: 512 },
];

for (const { file, size } of TARGETS) {
  const pixels = drawTomatoIcon(size);
  const png = encodePng(size, size, pixels);
  writeFileSync(path.join(PUBLIC_DIR, file), png);
  console.log(`generated ${file} (${size}x${size}, ${png.length} bytes)`);
}
