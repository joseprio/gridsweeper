// Board geometry and layout generation.
//
// Level L is a 9x9 grid. For L >= 1 its central 3x3 block (the "core") *is*
// level L-1, so core cells are not cells at all. Cells are squares, and two
// cells are neighbours when they touch (edge or corner), even across levels:
// an edge cell of level L touches the big level L+1 cells around it, and a
// level L cell next to the core touches the small edge cells of level L-1.
import { levelRng } from './rng.js';

export const SIZE = 9;
export const CELLS = SIZE * SIZE;
export const CORE_LO = 3;
export const CORE_HI = 5;

const MAX_ATTEMPTS = 400;
const rowCol = (i) => [Math.floor(i / SIZE), i % SIZE];

export function isCore(level, i) {
  if (level === 0) return false;
  const [r, c] = rowCol(i);
  return r >= CORE_LO && r <= CORE_HI && c >= CORE_LO && c <= CORE_HI;
}

// The ring of cells around the core: while level L is being played, these
// level L+1 cells are visible and playable.
export function isRing(i) {
  const [r, c] = rowCol(i);
  return r >= 2 && r <= 6 && c >= 2 && c <= 6 && !isCore(1, i);
}

export function mineCount(level) {
  return level === 0 ? 10 : Math.min(10 + level, 16);
}

const SAME = Array.from({ length: CELLS }, (_, i) => {
  const [r, c] = rowCol(i);
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if ((dr || dc) && rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) out.push(rr * SIZE + cc);
    }
  }
  return out;
});

// With level L cells as unit squares [c, c+1] x [r, r+1], level L+1 cells are
// 3-unit squares starting at -9. UP[i]: the level L+1 cells touching cell i.
const touches = (ax, ay, as, bx, by, bs) => ax <= bx + bs && bx <= ax + as && ay <= by + bs && by <= ay + as;
const UP = Array.from({ length: CELLS }, (_, i) => {
  const [r, c] = rowCol(i);
  const out = [];
  for (let j = 0; j < CELLS; j++) {
    const [R, C] = rowCol(j);
    if (!isCore(1, j) && touches(c, r, 1, -9 + 3 * C, -9 + 3 * R, 3)) out.push(j);
  }
  return out;
});
// DOWN[j]: the level L-1 cells touching level L cell j (the inverse of UP).
const DOWN = Array.from({ length: CELLS }, () => []);
UP.forEach((js, i) => js.forEach((j) => DOWN[j].push(i)));

// Neighbours as [levelDelta, index] pairs; level 0 has no core and no level below.
const REL = [0, 1].map((kind) =>
  Array.from({ length: CELLS }, (_, i) => {
    if (kind && isCore(1, i)) return [];
    const out = [];
    for (const j of SAME[i]) if (!(kind && isCore(1, j))) out.push([0, j]);
    for (const j of UP[i]) out.push([1, j]);
    if (kind) for (const j of DOWN[i]) out.push([-1, j]);
    return out;
  }),
);

export function neighbors(level, i) {
  return REL[level === 0 ? 0 : 1][i];
}

// All the mine layouts of one seed. Levels are generated in order, because
// level k's mines change the numbers of level k-1, so they are chosen to keep
// level k-1 solvable without guessing.
export class World {
  constructor(seed) {
    this.seed = seed;
    this.mines = []; // Uint8Array per level
    this.starts = []; // starts[p]: the cell opened for free when level p begins
    this.noGuess = []; // noGuess[p]: whether the solver cleared level p from its start
  }

  ensure(level) {
    while (this.mines.length <= level) this.generateNext();
  }

  mine(level, i) {
    return level >= 0 && this.mines[level] ? this.mines[level][i] : 0;
  }

  count(level, i) {
    let n = 0;
    for (const [dl, j] of neighbors(level, i)) n += this.mine(level + dl, j);
    return n;
  }

  generateNext() {
    const k = this.mines.length;
    const rng = levelRng(this.seed, k);
    const playable = [];
    for (let i = 0; i < CELLS; i++) if (!isCore(k, i)) playable.push(i);
    const total = mineCount(k);

    let best = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const order = rng.shuffle(playable.slice());
      const cand = new Uint8Array(CELLS);
      for (let q = 0; q < total; q++) cand[order[q]] = 1;
      const get = (l) => (l < k ? this.mines[l] : l === k ? cand : null);

      // Level k on its own (its outer neighbours don't exist yet) should be
      // clean, and with it in place, level k-1 must stay solvable.
      const own = solvePhase(get, k, rng).score;
      const prev = k > 0 ? solvePhase(get, k - 1, rng) : { score: 1, start: -1 };
      const score = own + prev.score;
      if (!best || score > best.score) best = { cand, score, prev };
      if (score === 2) break;
    }
    this.mines.push(best.cand);
    if (k > 0) {
      this.starts[k - 1] = best.prev.start;
      this.noGuess[k - 1] = best.prev.score === 1;
    }
  }
}

// Logic solver for "playing level p": level p-1 is fully known, level p is the
// goal, and the ring of level p+1 is playable too (the rest of p+1 is hidden:
// it can be reasoned about but not opened). Opens a start cell, then applies
// single-cell, subset and mine-total rules until stuck.
// Returns { score: fraction of level p's safe cells opened, start }.
export function solvePhase(get, p, rng) {
  const base = p - 1;
  const N = CELLS * 3;
  const KNOWN = 1, PLAYABLE = 2, HIDDEN = 3;
  const mine = new Uint8Array(N);
  const role = new Uint8Array(N);
  const totals = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const l = base + k;
    const m = l >= 0 ? get(l) : null;
    if (!m) continue;
    for (let i = 0; i < CELLS; i++) {
      if (isCore(l, i)) continue;
      const s = k * CELLS + i;
      mine[s] = m[i];
      totals[k] += m[i];
      role[s] = k === 0 ? KNOWN : k === 1 || isRing(i) ? PLAYABLE : HIDDEN;
    }
  }

  const adj = new Array(N);
  const cnt = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    if (!role[s]) continue;
    const l = base + Math.floor(s / CELLS);
    adj[s] = [];
    for (const [dl, j] of neighbors(l, s % CELLS)) {
      const k = l + dl - base;
      if (k < 0 || k > 2) continue;
      const t = k * CELLS + j;
      if (!role[t]) continue;
      adj[s].push(t);
      cnt[s] += mine[t];
    }
  }

  // Start: a zero, preferably touching the previous level.
  const safe = [];
  for (let i = 0; i < CELLS; i++) {
    const s = CELLS + i;
    if (role[s] === PLAYABLE && !mine[s]) safe.push(s);
  }
  const zeros = safe.filter((s) => cnt[s] === 0);
  let pool = zeros;
  if (p > 0) {
    const near = zeros.filter((s) => adj[s].some((t) => t < CELLS));
    if (near.length) pool = near;
  }
  if (!pool.length) {
    const min = Math.min(...safe.map((s) => cnt[s]));
    pool = safe.filter((s) => cnt[s] === min);
  }
  const start = pool[rng.int(pool.length)];

  const UNKNOWN = 0, OPENED = 1, MINE = 2, SAFE_HIDDEN = 3;
  const st = new Uint8Array(N);
  for (let s = 0; s < CELLS; s++) if (role[s] === KNOWN) st[s] = mine[s] ? MINE : OPENED;
  let opened = 0;
  const knownMines = [0, 0, 0];

  const open = (from) => {
    const stack = [from];
    while (stack.length) {
      const s = stack.pop();
      if (st[s] !== UNKNOWN) continue;
      if (role[s] === HIDDEN) { st[s] = SAFE_HIDDEN; continue; }
      if (mine[s]) throw new Error('solver opened a mine');
      st[s] = OPENED;
      if (s < 2 * CELLS) opened++;
      if (cnt[s] === 0) for (const t of adj[s]) if (st[t] === UNKNOWN) stack.push(t);
    }
  };
  const mark = (s) => {
    if (st[s] !== UNKNOWN) return;
    st[s] = MINE;
    knownMines[Math.floor(s / CELLS)]++;
  };

  const WORDS = 8;
  const bits = (cells) => {
    const b = new Uint32Array(WORDS);
    for (const s of cells) b[s >> 5] |= 1 << (s & 31);
    return b;
  };
  // Applies "exactly rem of these cells are mines". Returns true on progress.
  const apply = (cells, rem) => {
    if (!cells.length) return false;
    if (rem === 0) { cells.forEach(open); return true; }
    if (rem === cells.length) { cells.forEach(mark); return true; }
    return false;
  };

  open(start);
  const goal = safe.length;
  while (opened < goal) {
    let progress = false;
    const cons = [];
    for (let s = 0; s < N; s++) {
      if (st[s] !== OPENED || !adj[s]) continue;
      const unk = [];
      let flagged = 0;
      for (const t of adj[s]) {
        if (st[t] === UNKNOWN) unk.push(t);
        else if (st[t] === MINE) flagged++;
      }
      if (!unk.length) continue;
      if (apply(unk, cnt[s] - flagged)) progress = true;
      else cons.push({ cells: unk, rem: cnt[s] - flagged, bits: bits(unk) });
    }
    if (progress) continue;

    // Mine totals per level are known too.
    for (const k of [1, 2]) {
      if (!totals[k]) continue;
      const unk = [];
      for (let i = 0; i < CELLS; i++) if (role[k * CELLS + i] && st[k * CELLS + i] === UNKNOWN) unk.push(k * CELLS + i);
      const rem = totals[k] - knownMines[k];
      if (apply(unk, rem)) progress = true;
      else if (unk.length) cons.push({ cells: unk, rem, bits: bits(unk) });
    }
    if (progress) continue;

    // Subset rule: if A's cells are inside B's, B \ A holds B.rem - A.rem mines.
    for (const a of cons) {
      for (const b of cons) {
        if (a === b || a.cells.length >= b.cells.length) continue;
        let subset = true;
        for (let w = 0; w < WORDS && subset; w++) if (a.bits[w] & ~b.bits[w]) subset = false;
        if (!subset) continue;
        const diff = b.cells.filter((s) => !(a.bits[s >> 5] & (1 << (s & 31))));
        if (apply(diff, b.rem - a.rem)) progress = true;
      }
    }
    if (!progress) break;
  }
  return { score: opened / goal, start: start - CELLS };
}
