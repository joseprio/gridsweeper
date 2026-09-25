// Game state across nested levels. While level p is being played, its cells
// and the ring of level p+1 cells around it are playable; everything below p
// is solved. Cells are addressed by a global id: level * 81 + index.
import { CELLS, World, isCore, isRing, mineCount, neighbors } from './level.js';

export const COVERED = 0;
export const OPEN = 1;
export const FLAG = 2;

export const gid = (level, i) => level * CELLS + i;
export const split = (g) => [Math.floor(g / CELLS), g % CELLS];

function freshState(level) {
  const s = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) if (isCore(level, i)) s[i] = OPEN;
  return s;
}

export class Game {
  constructor(seed, { autoStart = true } = {}) {
    this.seed = seed;
    this.world = new World(seed);
    this.world.ensure(1);
    this.index = 0;
    this.status = 'playing'; // playing | cleared | lost
    this.elapsed = 0;
    this.exploded = -1;
    this.states = [freshState(0), freshState(1)];
    this.snapshot = null;
    if (autoStart) this.beginPhase();
  }

  get start() {
    return this.world.starts[this.index];
  }

  get minesLeft() {
    const s = this.states[this.index];
    let flags = 0;
    for (let i = 0; i < CELLS; i++) if (!isCore(this.index, i) && s[i] === FLAG) flags++;
    return mineCount(this.index) - flags;
  }

  stateOf(level, i) {
    return this.states[level] ? this.states[level][i] : COVERED;
  }

  isPlayable(level, i) {
    const p = this.index;
    if (level === p) return !isCore(p, i);
    if (level === p + 1) return isRing(i);
    return false;
  }

  // Cells the player can see and act on (solved lower levels are visible too,
  // so their numbers can be used for chording).
  isVisible(level, i) {
    return level >= 0 && level <= this.index + 1 && !isCore(level, i) && (level <= this.index || isRing(i));
  }

  count(level, i) {
    return this.world.count(level, i);
  }

  // BFS flood open over playable cells. Returns [{ g, depth }] in open order.
  flood(level, i, depth0 = 0) {
    const out = [];
    const queue = [[level, i, depth0]];
    while (queue.length) {
      const [l, j, depth] = queue.shift();
      if (!this.isPlayable(l, j) || this.states[l][j] !== COVERED || this.world.mine(l, j)) continue;
      this.states[l][j] = OPEN;
      out.push({ g: gid(l, j), depth });
      if (this.count(l, j) === 0) {
        for (const [dl, k] of neighbors(l, j)) queue.push([l + dl, k, depth + 1]);
      }
    }
    return out;
  }

  // Starts level `index`: opens around any zeros whose neighbours just became
  // playable, opens the start cell, and remembers the state for retries.
  beginPhase() {
    const p = this.index;
    const opened = [];
    for (const l of [p, p + 1]) {
      for (let i = 0; i < CELLS; i++) {
        if (this.states[l][i] !== OPEN || isCore(l, i) || !this.isVisible(l, i) || this.count(l, i)) continue;
        for (const [dl, k] of neighbors(l, i)) opened.push(...this.flood(l + dl, k, 1));
      }
    }
    opened.push(...this.flood(p, this.start));
    this.snapshot = [this.states[p].slice(), this.states[p + 1].slice()];
    return opened;
  }

  // Reveal a covered cell, or chord an opened number.
  primary(g) {
    if (this.status !== 'playing' || g < 0) return null;
    const [l, i] = split(g);
    if (!this.isVisible(l, i)) return null;
    const s = this.states[l][i];
    if (s === COVERED && this.isPlayable(l, i)) return this.reveal(l, i);
    if (s === OPEN) return this.chord(l, i);
    return null;
  }

  reveal(l, i) {
    if (this.world.mine(l, i)) return this.lose(l, i);
    const opened = this.flood(l, i);
    return { type: 'open', opened, cleared: this.checkCleared() };
  }

  chord(l, i) {
    const count = this.count(l, i);
    if (!count) return null;
    let flags = 0;
    const covered = [];
    for (const [dl, k] of neighbors(l, i)) {
      const s = this.stateOf(l + dl, k);
      if (s === FLAG) flags++;
      else if (s === COVERED && this.isPlayable(l + dl, k)) covered.push([l + dl, k]);
    }
    if (flags !== count || !covered.length) return null;
    const hit = covered.find(([cl, ck]) => this.world.mine(cl, ck));
    if (hit) return this.lose(...hit);
    const opened = [];
    for (const [cl, ck] of covered) opened.push(...this.flood(cl, ck, 1));
    return { type: 'open', opened, cleared: this.checkCleared() };
  }

  toggleFlag(g) {
    if (this.status !== 'playing' || g < 0) return null;
    const [l, i] = split(g);
    if (!this.isPlayable(l, i)) return null;
    const s = this.states[l];
    if (s[i] === COVERED) { s[i] = FLAG; return { type: 'flag', on: true }; }
    if (s[i] === FLAG) { s[i] = COVERED; return { type: 'flag', on: false }; }
    return null;
  }

  lose(l, i) {
    this.exploded = gid(l, i);
    this.status = 'lost';
    return { type: 'lost', at: this.exploded };
  }

  // The level is cleared once every safe cell of the current level is open;
  // the ring cells are optional.
  checkCleared() {
    const p = this.index;
    const s = this.states[p];
    for (let i = 0; i < CELLS; i++) {
      if (!isCore(p, i) && !this.world.mine(p, i) && s[i] !== OPEN) return false;
    }
    for (let i = 0; i < CELLS; i++) if (this.world.mine(p, i)) s[i] = FLAG;
    this.status = 'cleared';
    return true;
  }

  // Makes sure the level after next exists (needed for the next level's numbers).
  prepareNext() {
    const p = this.index;
    this.world.ensure(p + 2);
    if (!this.states[p + 2]) this.states[p + 2] = freshState(p + 2);
  }

  enterNext() {
    this.prepareNext();
    this.index++;
    this.status = 'playing';
    this.exploded = -1;
    return this.beginPhase();
  }

  retryLevel() {
    const p = this.index;
    this.states[p] = this.snapshot[0].slice();
    this.states[p + 1] = this.snapshot[1].slice();
    this.states.length = p + 2;
    this.status = 'playing';
    this.exploded = -1;
    return [];
  }

  serialize() {
    const p = this.index;
    const str = (a) => Array.from(a).join('');
    return {
      v: 2,
      seed: this.seed,
      index: p,
      status: this.status,
      elapsed: Math.round(this.elapsed),
      exploded: this.exploded,
      states: [str(this.states[p]), str(this.states[p + 1])],
      snapshot: this.snapshot.map(str),
    };
  }

  static restore(data) {
    if (!data || data.v !== 2 || typeof data.seed !== 'string') return null;
    const p = data.index | 0;
    const valid = (s) => typeof s === 'string' && s.length === CELLS && /^[012]+$/.test(s);
    if (p < 0 || p > 500 || ![...(data.states || []), ...(data.snapshot || [])].every(valid)) return null;
    if (data.states.length !== 2 || data.snapshot.length !== 2) return null;

    const game = new Game(data.seed, { autoStart: false });
    game.world.ensure(p + 1);
    const parse = (str, level) => {
      const s = freshState(level);
      for (let i = 0; i < CELLS; i++) if (!isCore(level, i)) s[i] = Number(str[i]);
      return s;
    };
    game.states = [];
    for (let l = 0; l < p; l++) {
      const s = freshState(l);
      for (let i = 0; i < CELLS; i++) if (!isCore(l, i)) s[i] = game.world.mine(l, i) ? FLAG : OPEN;
      game.states.push(s);
    }
    game.states.push(parse(data.states[0], p), parse(data.states[1], p + 1));
    game.snapshot = [parse(data.snapshot[0], p), parse(data.snapshot[1], p + 1)];
    game.index = p;
    game.elapsed = data.elapsed || 0;
    game.status = data.status === 'lost' ? 'lost' : 'playing';
    game.exploded = game.status === 'lost' ? data.exploded : -1;
    if (data.status === 'cleared' && game.checkCleared()) game.enterNext();
    return game;
  }
}
