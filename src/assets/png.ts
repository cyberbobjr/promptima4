// Decodes the extractor's palette PNGs back to EGA colour indices. The PNG is parsed here (8-bit palette
// images, as the extractor writes them): reading the pixels back from a canvas is not exact everywhere, since
// browsers with fingerprinting protection (Brave, Safari private browsing, Firefox resistFingerprinting) add
// noise to getImageData. Other PNG formats still go through a canvas.
import { EGA_PALETTE, type IndexedImage } from "../formats/ega";

const INDEX = new Map(EGA_PALETTE.map(([r, g, b], i) => [(r << 16) | (g << 8) | b, i]));

function egaIndex(r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b, idx = INDEX.get(key);
  if (idx === undefined) throw new Error(`PNG colour #${key.toString(16).padStart(6, "0")} is not an EGA colour`);
  return idx;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 8-bit palette PNG without interlace -> EGA indices, or null for any other format. */
async function decodePalettePng(buf: Uint8Array): Promise<IndexedImage | null> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0, height = 0, palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = view.getUint32(p), type = String.fromCharCode(...buf.subarray(p + 4, p + 8)), data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(p + 8); height = view.getUint32(p + 12);
      // bit depth 8, colour type 3 (palette), no interlace
      if (data[8] !== 8 || data[9] !== 3 || data[12] !== 0) return null;
    } else if (type === "PLTE") palette = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!width || !palette) return null;
  const packed = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  idat.reduce((o, d) => (packed.set(d, o), o + d.length), 0);
  const raw = await inflate(packed);
  // undo the per-row filters (1 byte per pixel), then map each palette entry to its EGA colour
  const map: number[] = new Array(palette.length / 3).fill(-1);
  const pixels = new Uint8Array(width * height);
  const prev = new Uint8Array(width), cur = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1), filter = raw[row];
    for (let x = 0; x < width; x++) {
      const v = raw[row + 1 + x], a = x > 0 ? cur[x - 1] : 0, b = prev[x], c = x > 0 ? prev[x - 1] : 0;
      let out: number;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      cur[x] = out & 255;
      let m = map[cur[x]];
      if (m === undefined) throw new Error(`PNG palette index ${cur[x]} out of range`);
      if (m < 0) m = map[cur[x]] = egaIndex(palette[cur[x] * 3], palette[cur[x] * 3 + 1], palette[cur[x] * 3 + 2]);
      pixels[y * width + x] = m;
    }
    prev.set(cur);
  }
  return { width, height, pixels };
}

/** Any other PNG: through a canvas (exact only where the browser does not add noise to read-backs). */
async function decodeWithCanvas(blob: Blob): Promise<IndexedImage> {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const pixels = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = egaIndex(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  const { width, height } = bmp;
  bmp.close(); // a closed bitmap reports 0x0
  return { width, height, pixels };
}

export async function decodeIndexedPng(blob: Blob): Promise<IndexedImage> {
  return (await decodePalettePng(new Uint8Array(await blob.arrayBuffer()))) ?? decodeWithCanvas(blob);
}
