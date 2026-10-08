// Single source of randomness for the engine. Unseeded it uses Math.random; a seed
// (dev: ?seed=N) makes runs reproducible for the headless regression scenarios.
let next: () => number = Math.random;
/**
 * Separate stream for the noise of the PC-speaker effects (src/audio/speaker.ts). The original draws
 * them from the game generator (1000:1771), but the port's generator is not the original one anyway,
 * and a separate stream keeps the game rolls identical whether the sound is on, off or silent.
 */
let nextSound: () => number = Math.random;

/** mulberry32: small, fast, good enough for game rolls. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function setSeed(seed: number): void {
  next = mulberry32(seed);
  nextSound = mulberry32(seed ^ 0x50c0ffee);
}

/** Uniform float in [0, 1). */
export const random = (): number => next();
/** Uniform integer in [0, n). */
export const rand = (n: number): number => Math.floor(next() * n);
/** The original's 8-bit random byte (0..255). */
export const rand8 = (): number => rand(256);
/** Random byte of the sound stream (speaker noise effects only). */
export const soundRand8 = (): number => Math.floor(nextSound() * 256);
