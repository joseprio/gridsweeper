// Seeded pseudo-random numbers. Same seed string => same sequence, on every platform.

// cyrb128: hashes a string into four 32-bit words suitable for seeding sfc32.
export function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

// sfc32: small, fast, 128-bit state PRNG. Returns floats in [0, 1).
export function sfc32(a, b, c, d) {
  return function next() {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(key) {
    this.next = sfc32(...cyrb128(String(key)));
    for (let i = 0; i < 16; i++) this.next(); // warm up
  }

  int(n) {
    return Math.floor(this.next() * n);
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// Every level gets its own independent stream, so level N never depends on
// how levels before it were played.
export function levelRng(seed, level) {
  return new Rng(`gridsweeper:${seed}:${level}`);
}

const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeSeed(raw) {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 24);
}

export function randomSeed(length = 6) {
  const bytes = new Uint32Array(length);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 2 ** 32);
  let out = '';
  for (let i = 0; i < length; i++) out += SEED_ALPHABET[bytes[i] % SEED_ALPHABET.length];
  return out;
}
