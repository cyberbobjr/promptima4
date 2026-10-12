// Alpha masks for the PixelLab Wang corner transition sets: which pixels of a transition tile belong to the
// upper terrain. Shared by pixellab-sample.mjs (mock scene) and build-pixellab.mjs (layered pack).
//
// A set is 16 opaque tiles keyed by their corners "NWNESWSE" (1 = upper terrain), the lower terrain painted in.
// A colour found only in the all-lower tile (0000) -> lower (transparent); only in the all-upper tile (1111),
// or in neither (the sand or mud band of the transition) -> upper (opaque); a colour both terrains use ->
// decided by its already-classified 4-neighbours (iterative), finally by the corner quadrant.

/** 1 if pixel p of a size x size tile lies in a quadrant whose corner is "1" in the pattern c. */
export function corner(c, p, size) {
  const h = size / 2;
  return c[((p / size | 0) < h ? 0 : 2) + (p % size < h ? 0 : 1)] === "1" ? 1 : 0;
}

/**
 * mask(c) -> Float32Array(size * size), 0..1 per pixel (times the tile's own alpha). Without a set (tiles null)
 * the mask is the plain corner quadrants. Masks are cached per pattern.
 */
export function transitionMasks(tiles, size) {
  const masks = {};
  // palette of the lower terrain: colours of the all-lower tile; of the upper one: the all-upper tile
  const pal = (img) => { const s = new Map(); for (let i = 0; i < img.data.length; i += 4) s.set((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2], [img.data[i], img.data[i + 1], img.data[i + 2]]); return [...s.values()]; };
  const lowPal = tiles ? pal(tiles["0000"]) : [], upPal = tiles ? pal(tiles["1111"]) : [];
  const near = (p, r, g, b) => Math.min(...p.map(([R, G, B]) => (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2));
  return (c) => {
    if (masks[c]) return masks[c];
    const m = new Float32Array(size * size);
    if (!tiles) { for (let p = 0; p < m.length; p++) m[p] = corner(c, p, size); return (masks[c] = m); }
    const img = tiles[c], label = new Int8Array(size * size);
    for (let p = 0; p < m.length; p++) {
      const [r, g, b] = img.data.slice(p * 4, p * 4 + 3), dl = near(lowPal, r, g, b), du = near(upPal, r, g, b);
      label[p] = dl < 300 && du < 300 ? -1 : dl < 300 && dl < du ? 0 : 1;
    }
    for (let pass = 0; pass < size && label.includes(-1); pass++) {
      const next = label.slice();
      for (let p = 0; p < m.length; p++) if (label[p] === -1) {
        const x = p % size, y = p / size | 0; let up = 0, low = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= size || Y >= size) continue;
          const l = label[Y * size + X]; if (l === 1) up++; else if (l === 0) low++;
        }
        if (up || low) next[p] = up > low ? 1 : up < low ? 0 : corner(c, p, size);
      }
      label.set(next);
    }
    for (let p = 0; p < m.length; p++) m[p] = (label[p] === -1 ? corner(c, p, size) : label[p]) * img.data[p * 4 + 3] / 255;
    return (masks[c] = m);
  };
}
