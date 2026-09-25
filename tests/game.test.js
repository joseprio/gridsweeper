import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, isCore, isRing, mineCount, neighbors, CELLS } from '../src/level.js';
import { Game, COVERED, OPEN, FLAG, gid, split } from '../src/game.js';
import { normalizeSeed, Rng } from '../src/rng.js';

const ids = (l, pairs) => pairs.filter(([dl]) => dl !== 0).map(([dl, j]) => [l + dl, j]);

test('rng is deterministic per key', () => {
  const a = new Rng('x'), b = new Rng('x'), c = new Rng('y');
  const sa = [a.next(), a.next(), a.next()];
  assert.deepEqual(sa, [b.next(), b.next(), b.next()]);
  assert.notDeepEqual(sa, [c.next(), c.next(), c.next()]);
});

test('edge cells touch the next level, core-adjacent cells touch the previous one', () => {
  // Level 0 corner (0,0) touches the level 1 corner-diagonal cell and the two beside it.
  assert.deepEqual(ids(0, neighbors(0, 0)), [[1, 20], [1, 21], [1, 29]]);
  // (0,1) sits entirely along the bottom of level 1 cell (2,3).
  assert.deepEqual(ids(0, neighbors(0, 1)), [[1, 21]]);
  // (0,2) is on the boundary between level 1 cells (2,3) and (2,4).
  assert.deepEqual(ids(0, neighbors(0, 2)), [[1, 21], [1, 22]]);
  // Interior cells have no cross-level neighbours; level 0 has nothing below it.
  assert.deepEqual(ids(0, neighbors(0, 40)), []);
  // Level 1 ring cell (2,3) touches level 0 cells (0,0)..(0,3); corner (2,2) touches just (0,0).
  assert.deepEqual(ids(1, neighbors(1, 21)), [[0, 0], [0, 1], [0, 2], [0, 3]]);
  assert.deepEqual(ids(1, neighbors(1, 20)), [[0, 0]]);
  // Neighbourship is symmetric across levels.
  for (let i = 0; i < CELLS; i++) {
    for (const [dl, j] of neighbors(3, i)) {
      if (dl) assert.ok(neighbors(3 + dl, j).some(([d, k]) => d === -dl && k === i));
    }
  }
});

test('same seed gives the same mines, different seeds differ', () => {
  const a = new World('ABC'), b = new World('ABC'), c = new World('ABD');
  [a, b, c].forEach((w) => w.ensure(4));
  for (let l = 0; l <= 4; l++) {
    assert.deepEqual(a.mines[l], b.mines[l]);
    assert.notDeepEqual(a.mines[l], c.mines[l]);
  }
  assert.deepEqual(a.starts, b.starts);
});

test('layouts respect mine counts, keep the core empty and are solvable', () => {
  let noGuess = 0, total = 0;
  for (let s = 0; s < 15; s++) {
    const w = new World(`T${s}`);
    w.ensure(6);
    for (let l = 0; l <= 6; l++) {
      assert.equal(w.mines[l].reduce((n, m) => n + m, 0), mineCount(l));
      for (let i = 0; i < CELLS; i++) if (isCore(l, i)) assert.equal(w.mines[l][i], 0);
    }
    for (let p = 0; p < 6; p++) {
      const start = w.starts[p];
      assert.equal(w.mine(p, start), 0);
      assert.ok(!isCore(p, start));
      total++;
      noGuess += w.noGuess[p];
    }
  }
  assert.ok(noGuess / total > 0.95, `only ${noGuess}/${total} levels were guess-free`);
});

test('numbers count mines on neighbouring levels', () => {
  const g = new Game('CROSS');
  const w = g.world;
  // Find a level 0 edge cell with a mine among its level 1 neighbours.
  const i = [...Array(CELLS).keys()].find((k) => neighbors(0, k).some(([dl, j]) => dl === 1 && w.mine(1, j)));
  assert.ok(i !== undefined);
  const same = neighbors(0, i).filter(([dl]) => dl === 0).reduce((n, [, j]) => n + w.mine(0, j), 0);
  assert.ok(w.count(0, i) > same);
});

test('ring cells are playable, hidden next-level cells are not', () => {
  const g = new Game('RING');
  const ring = [...Array(CELLS).keys()].filter(isRing);
  assert.equal(ring.length, 16);
  const safeRing = ring.find((j) => !g.world.mine(1, j) && g.stateOf(1, j) === COVERED);
  const res = g.primary(gid(1, safeRing));
  assert.equal(res.type, 'open');
  assert.equal(g.stateOf(1, safeRing), OPEN);
  const hidden = [...Array(CELLS).keys()].find((j) => !isRing(j) && !isCore(1, j));
  assert.equal(g.toggleFlag(gid(1, hidden)), null);
  assert.equal(g.primary(gid(1, hidden)), null);
});

test('blank areas uncover next-level locked cells, which still can\'t be clicked', () => {
  const g = new Game('G83F3G');
  const locked = [...Array(CELLS).keys()].filter((i) => !isRing(i) && !isCore(1, i));
  assert.ok(locked.some((i) => g.stateOf(1, i) === OPEN), 'the opening should reach locked cells');
  // No opened blank cell is left next to a covered cell it could have opened.
  for (const l of [0, 1, 2]) {
    for (let i = 0; i < CELLS; i++) {
      if (isCore(l, i) || g.stateOf(l, i) !== OPEN || g.count(l, i)) continue;
      for (const [dl, j] of neighbors(l, i)) {
        if (g.isReachable(l + dl, j)) assert.notEqual(g.stateOf(l + dl, j), COVERED);
      }
    }
  }
  const coveredLocked = locked.find((i) => g.stateOf(1, i) === COVERED);
  assert.equal(g.primary(gid(1, coveredLocked)), null);
  assert.equal(g.toggleFlag(gid(1, coveredLocked)), null);
  // Uncovering reaches two levels ahead, and one more level is generated so
  // the numbers on uncovered cells there are real.
  assert.ok(g.world.mines.length >= 4);
  assert.ok(g.isReachable(2, 0) && !g.isReachable(3, 0));
});

function clearLevel(game) {
  const p = game.index;
  for (let i = 0; i < CELLS; i++) {
    if (game.stateOf(p, i) === COVERED && !isCore(p, i) && !game.world.mine(p, i)) game.primary(gid(p, i));
    if (game.status !== 'playing') break;
  }
}

test('clearing a level zooms out; opened ring cells carry over', () => {
  const game = new Game('ZOOM');
  const ring = [...Array(CELLS).keys()].find((j) => isRing(j) && !game.world.mine(1, j) && game.stateOf(1, j) === COVERED);
  game.primary(gid(1, ring));
  clearLevel(game);
  assert.equal(game.status, 'cleared');
  game.enterNext();
  assert.equal(game.index, 1);
  assert.equal(game.status, 'playing');
  assert.equal(game.stateOf(1, ring), OPEN);
  assert.equal(game.stateOf(1, game.start), OPEN);
  for (let i = 0; i < CELLS; i++) {
    assert.equal(game.stateOf(0, i), game.world.mine(0, i) ? FLAG : OPEN);
  }
  clearLevel(game);
  assert.equal(game.status, 'cleared');
});

test('chording works across levels', () => {
  const game = new Game('CHORD');
  clearLevel(game);
  game.enterNext();
  // A solved level 0 edge number chords into level 1 once its flags are placed.
  const w = game.world;
  const i = [...Array(CELLS).keys()].find((k) => game.stateOf(0, k) === OPEN &&
    neighbors(0, k).some(([dl, j]) => dl === 1 && game.stateOf(1, j) === COVERED && !w.mine(1, j)));
  assert.ok(i !== undefined, 'layout has nothing to chord; pick another seed');
  for (const [dl, j] of neighbors(0, i)) if (dl === 1 && w.mine(1, j) && game.stateOf(1, j) === COVERED) game.toggleFlag(gid(1, j));
  const res = game.primary(gid(0, i));
  assert.equal(res.type, 'open');
  for (const [dl, j] of neighbors(0, i)) if (dl === 1) assert.notEqual(game.stateOf(1, j), COVERED);
});

test('hitting a mine loses; retry restores the start of the level', () => {
  const game = new Game('BOOM');
  const before = [...game.states[0]];
  const mine = game.world.mines[0].indexOf(1);
  assert.equal(game.primary(gid(0, mine)).type, 'lost');
  assert.equal(game.status, 'lost');
  game.retryLevel();
  assert.equal(game.status, 'playing');
  assert.deepEqual([...game.states[0]], before);
  assert.equal(game.exploded, -1);
});

test('save and restore round-trips mid-game', () => {
  const game = new Game('SAVE');
  clearLevel(game);
  game.enterNext();
  const mine = [...Array(CELLS).keys()].find((i) => game.world.mine(1, i) && game.stateOf(1, i) === COVERED);
  game.toggleFlag(gid(1, mine));
  game.elapsed = 12345;
  const copy = Game.restore(JSON.parse(JSON.stringify(game.serialize())));
  assert.equal(copy.index, 1);
  assert.deepEqual(copy.states[1], game.states[1]);
  assert.deepEqual(copy.states[2], game.states[2]);
  assert.deepEqual(copy.states[0], game.states[0]);
  assert.equal(copy.minesLeft, game.minesLeft);
  assert.equal(copy.elapsed, 12345);
  assert.equal(Game.restore({ v: 1 }), null);
  // Older saves that tracked two levels still load.
  const v2 = { ...game.serialize(), v: 2 };
  v2.states = v2.states.slice(0, 2);
  v2.snapshot = v2.snapshot.slice(0, 2);
  assert.equal(Game.restore(v2).index, 1);
  assert.equal(Game.restore({ ...game.serialize(), states: ['x'.repeat(81), '0'.repeat(81), '0'.repeat(81)] }), null);
  const coreCovered = Game.restore({ ...game.serialize(), states: ['0'.repeat(81), '0'.repeat(81), '0'.repeat(81)] });
  for (let i = 0; i < CELLS; i++) if (isCore(1, i)) assert.equal(coreCovered.stateOf(1, i), OPEN);
});

test('seeds are normalized and gid round-trips', () => {
  assert.equal(normalizeSeed('  ab c-9! '), 'ABC-9');
  assert.deepEqual(split(gid(7, 42)), [7, 42]);
});
