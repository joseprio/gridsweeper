import { Game, COVERED, FLAG, OPEN, split } from './game.js';
import { SIZE } from './level.js';
import { Renderer } from './render.js';
import { setupPointer, setupKeyboard, createGamepadPoller } from './input.js';
import { normalizeSeed, randomSeed } from './rng.js';
import { sound } from './sound.js';

const SAVE_KEY = 'gridsweeper.save';
const BEST_KEY = 'gridsweeper.best';
const PREFS_KEY = 'gridsweeper.prefs';
const CELEBRATE_MS = 700;
const ZOOM_MS = 1300;

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const renderer = new Renderer(canvas);

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode, quota */ }
  },
};

let game = null;
let anim = null; // { phase: 'celebrate' | 'zoom', t0 }
let acted = false; // the clock starts on the first move of a session
let flagMode = false;
let dirty = true;
const ui = { now: 0, hover: -1, pressed: -1, cursor: -1, showCursor: false, openAt: new Map() };

// ---------- overlays ----------
const overlays = { menu: $('ov-menu'), over: $('ov-over'), help: $('ov-help'), confirm: $('ov-confirm') };
let overlayStack = [];

function openOverlay(name) {
  overlayStack = overlayStack.filter((n) => n !== name);
  overlayStack.push(name);
  for (const [n, el] of Object.entries(overlays)) el.hidden = n !== name;
  ui.pressed = -1;
  const first = overlays[name].querySelector('.btn.primary:not([hidden])') || overlays[name].querySelector('button');
  first?.focus({ preventScroll: true });
  dirty = true;
}

function closeOverlay() {
  overlayStack.pop();
  for (const el of Object.values(overlays)) el.hidden = true;
  const prev = overlayStack.pop();
  if (prev) openOverlay(prev);
  else document.activeElement?.blur?.();
  dirty = true;
}

function closeAllOverlays() {
  overlayStack = [];
  for (const el of Object.values(overlays)) el.hidden = true;
  document.activeElement?.blur?.();
  dirty = true;
}

const currentOverlay = () => (overlayStack.length ? overlays[overlayStack.at(-1)] : null);

function showMenu() {
  const canContinue = game && game.status !== 'lost';
  $('menu-continue').hidden = !canContinue;
  $('menu-continue').textContent = game && (acted || game.index > 0 || game.elapsed > 0) ? `Continue (level ${game.index + 1})` : 'Play';
  $('menu-seed').value = '';
  $('menu-seed').placeholder = game ? game.seed : 'e.g. K3VQ8P';
  const best = store.get(BEST_KEY);
  $('menu-best').textContent = best ? `Best: level ${best}` : '';
  openOverlay('menu');
}

let toastTimer = 0;
function toast(msg, ms = 1600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- game lifecycle ----------
function startGame(seed) {
  game = new Game(seed, { autoStart: false });
  anim = null;
  zoomE = null;
  renderer.pan = { x: 0, y: 0 };
  acted = false;
  ui.openAt.clear();
  animateOpen(game.beginPhase());
  placeCursor(game.index * 81 + game.start);
  setUrlSeed(seed);
  save();
  dirty = true;
}

function setUrlSeed(seed) {
  const url = new URL(location.href);
  url.searchParams.set('seed', seed);
  history.replaceState(null, '', url);
}

function save() {
  if (game) store.set(SAVE_KEY, game.serialize());
}

function recordBest() {
  const best = store.get(BEST_KEY) || 0;
  if (game.index + 1 > best) store.set(BEST_KEY, game.index + 1);
}

function animateOpen(opened) {
  const now = performance.now();
  for (const { g, depth } of opened) ui.openAt.set(g, now + Math.min(depth, 12) * 22);
}

function handleResult(res) {
  if (!res) return;
  acted = true;
  if (res.type === 'open') {
    animateOpen(res.opened);
    sound.open(res.opened.length);
    if (res.cleared) beginClear();
  } else if (res.type === 'flag') {
    sound.flag(res.on);
    vibrate(12);
  } else if (res.type === 'lost') {
    sound.boom();
    vibrate([60, 40, 160]);
    recordBest();
    const t = formatTime(game.elapsed);
    $('over-text').textContent = `You reached level ${game.index + 1} in ${t}. Seed ${game.seed}.`;
    setTimeout(() => { if (game.status === 'lost') openOverlay('over'); }, 650);
  }
  save();
  dirty = true;
}

function beginClear() {
  game.prepareNext();
  anim = { phase: 'celebrate', t0: performance.now() };
  sound.clear();
  vibrate(30);
  toast(`Level ${game.index + 1} cleared!`);
}

function finishZoom() {
  anim = null;
  ui.openAt.clear();
  const opened = game.enterNext();
  animateOpen(opened);
  placeCursor(game.index * 81 + game.start);
  recordBest();
  toast(`Level ${game.index + 1}`);
  save();
}

function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

// ---------- actions ----------
const canPlay = () => !!game && game.status === 'playing' && !anim && !currentOverlay();

function primary(i) {
  if (!canPlay() || i < 0) return;
  handleResult(game.primary(i));
}

function flag(i) {
  if (!canPlay() || i < 0) return;
  handleResult(game.toggleFlag(i));
}

const stateOf = (g) => game.stateOf(...split(g));

function tap(g) {
  if (!canPlay() || g < 0) return;
  const st = stateOf(g);
  if (flagMode && st !== OPEN) flag(g);
  else if (st !== FLAG) primary(g);
}

function longPress(g) {
  if (!canPlay() || g < 0) return;
  vibrate(20);
  if (flagMode) primary(g);
  else if (stateOf(g) !== OPEN) flag(g);
  else primary(g);
}

// The keyboard/gamepad cursor lives on a grid of current-level cell units
// that spans the level and the ring around it (-3..11); ring cells are 3x3
// units, so moving onto one and off again takes one step each way.
const cursorUnits = { u: 4, v: 4 };

function placeCursor(g) {
  const [l, i] = split(g);
  const r = Math.floor(i / SIZE), c = i % SIZE;
  if (l === game.index) Object.assign(cursorUnits, { u: c, v: r });
  else Object.assign(cursorUnits, { u: 3 * c - 8, v: 3 * r - 8 });
  ui.cursor = g;
  dirty = true;
}

function moveCursor(dr, dc) {
  if (!game) return;
  const p = game.index;
  let { u, v } = cursorUnits;
  const from = renderer.cellAtUnits(u + 0.5, v + 0.5, p);
  for (let step = 0; step < 16; step++) {
    u += dc;
    v += dr;
    if (u < -3 || v < -3 || u > 11 || v > 11) return; // edge of the ring
    const g = renderer.cellAtUnits(u + 0.5, v + 0.5, p);
    if (g >= 0 && g !== from) {
      Object.assign(cursorUnits, { u, v });
      ui.cursor = g;
      renderer.reveal(g, game);
      dirty = true;
      return;
    }
  }
}

function setFlagMode(on) {
  flagMode = on;
  $('btn-flag').setAttribute('aria-pressed', String(on));
  toast(on ? 'Flag mode: taps place flags' : 'Flag mode off', 1100);
}

function setSound(on) {
  sound.enabled = on;
  $('btn-sound').setAttribute('aria-pressed', String(on));
  store.set(PREFS_KEY, { sound: on });
}

function retryLevel() {
  if (!game || anim) return;
  closeAllOverlays();
  ui.openAt.clear();
  animateOpen(game.retryLevel());
  placeCursor(game.index * 81 + game.start);
  save();
  toast(`Level ${game.index + 1}: try again`);
  dirty = true;
}

// Has anything changed since the level started (the state a retry goes back to)?
function levelTouched() {
  const p = game.index;
  return game.snapshot.some((snap, k) => snap.some((v, i) => v !== game.states[p + k][i]));
}

// Restarting throws away progress, so ask first, unless the level is already
// lost or nothing has been done yet.
function requestRetry() {
  if (!game || anim) return;
  if (game.status === 'lost' || !levelTouched()) {
    retryLevel();
    return;
  }
  $('confirm-text').textContent =
    `Your progress on level ${game.index + 1} will be lost. The mines stay in the same places.`;
  openOverlay('confirm');
}

function command(name) {
  switch (name) {
    case 'flagMode': setFlagMode(!flagMode); break;
    case 'retry': if (!currentOverlay()) requestRetry(); break;
    case 'menu': currentOverlay() ? closeOverlay() : showMenu(); break;
    case 'help': openOverlay('help'); break;
    case 'center': if (game) placeCursor(game.index * 81 + game.start); break;
    case 'back':
      if (overlayStack.at(-1) === 'menu' && (!game || game.status === 'lost')) return;
      closeOverlay();
      break;
  }
}

async function copySeedLink() {
  if (!game) return;
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('seed', game.seed);
  try {
    await navigator.clipboard.writeText(url.toString());
    toast('Link to this seed copied');
  } catch {
    toast(`Seed: ${game.seed}`);
  }
}

// ---------- wiring ----------
setupPointer(canvas, {
  hit: (x, y) => (game ? renderer.hit(x, y, game) : -1),
  canPlay,
  tap,
  long: longPress,
  flag,
  chord: primary,
  hover: (i) => { if (ui.hover !== i) { ui.hover = i; dirty = true; } },
  pressed: (i) => { if (ui.pressed !== i) { ui.pressed = i; dirty = true; } },
  pan: (dx, dy) => { if (renderer.panBy(dx, dy)) dirty = true; },
  usedPointer: () => { sound.unlock(); if (ui.showCursor) { ui.showCursor = false; dirty = true; } },
});

const keyHandlers = {
  overlay: currentOverlay,
  move: moveCursor,
  cursorPrimary: () => primary(ui.cursor),
  cursorFlag: () => flag(ui.cursor),
  usedKeys: () => { sound.unlock(); ui.hover = -1; if (!ui.showCursor) { ui.showCursor = true; dirty = true; } },
  command,
};
setupKeyboard(keyHandlers);
const pollGamepads = createGamepadPoller(keyHandlers);
window.addEventListener('gamepadconnected', () => toast('Gamepad connected'));

$('btn-flag').addEventListener('click', () => setFlagMode(!flagMode));
$('btn-retry').addEventListener('click', requestRetry);
$('btn-menu').addEventListener('click', showMenu);
$('btn-help').addEventListener('click', () => openOverlay('help'));
$('btn-sound').addEventListener('click', () => setSound(!sound.enabled));
$('hud-seed').addEventListener('click', copySeedLink);

$('menu-continue').addEventListener('click', () => { sound.unlock(); closeAllOverlays(); });
$('menu-new').addEventListener('click', () => { sound.unlock(); startGame(randomSeed()); closeAllOverlays(); });
$('menu-help').addEventListener('click', () => openOverlay('help'));
$('menu-seed-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sound.unlock();
  const seed = normalizeSeed($('menu-seed').value) || game?.seed || randomSeed();
  startGame(seed);
  closeAllOverlays();
});
$('over-retry').addEventListener('click', retryLevel);
$('confirm-yes').addEventListener('click', retryLevel);
$('confirm-no').addEventListener('click', closeOverlay);
$('over-look').addEventListener('click', () => { closeAllOverlays(); toast('Press Retry to try this level again', 2400); });
$('over-new').addEventListener('click', () => { startGame(randomSeed()); closeAllOverlays(); });
$('help-close').addEventListener('click', closeOverlay);

// Taps outside a panel close optional overlays.
for (const el of Object.values(overlays)) {
  el.addEventListener('pointerdown', (e) => { if (e.target === el) command('back'); });
}

// Resizing clears the canvas, and the observer runs after this frame's draw,
// so redraw right away or the board is blank for as long as the resize lasts.
new ResizeObserver(() => {
  renderer.resize();
  if (game) renderer.draw(game, currentView(), ui);
}).observe(canvas);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
window.addEventListener('pagehide', save);

// ---------- loop ----------
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
let lastTime = performance.now();
let shownTime = '';

let zoomE = null; // zoom-out progress (0..1) while zooming, else null

// What the camera shows: the level being played, or, while zooming out, the
// next level growing into place.
function currentView() {
  if (zoomE === null) return { top: game.index, cell: renderer.cell, e: 0 };
  return { top: game.index + 1, cell: renderer.cell * 3 ** (1 - zoomE), e: zoomE };
}

function frame() {
  // Same clock as animateOpen()/beginClear(); rAF's timestamp can lag behind it.
  const now = performance.now();
  const dt = Math.min(250, Math.max(0, now - lastTime));
  lastTime = now;
  ui.now = now;
  pollGamepads(now);

  if (game && acted && game.status === 'playing' && !currentOverlay() && !document.hidden) game.elapsed += dt;

  if (anim?.phase === 'celebrate' && now - anim.t0 >= CELEBRATE_MS) {
    anim = { phase: 'zoom', t0: now, pan: { ...renderer.pan } };
    sound.zoom();
  }
  if (anim?.phase === 'zoom') {
    const t = Math.min(1, (now - anim.t0) / ZOOM_MS);
    zoomE = easeInOut(t);
    renderer.pan = { x: anim.pan.x * (1 - zoomE), y: anim.pan.y * (1 - zoomE) }; // drift back to centre
    if (t >= 1) {
      zoomE = null;
      finishZoom();
    }
  }

  let opening = false;
  for (const t0 of ui.openAt.values()) if (now < t0 + 160) { opening = true; break; }
  if (game && (dirty || anim || opening || ui.showCursor)) {
    renderer.draw(game, currentView(), ui);
    dirty = false;
  }
  if (game) updateHud();
  requestAnimationFrame(frame);
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function updateHud() {
  const time = formatTime(game.elapsed);
  const key = `${game.index}|${game.minesLeft}|${time}|${game.seed}`;
  if (key === shownTime) return;
  shownTime = key;
  $('hud-level').textContent = String(game.index + 1);
  $('hud-mines').textContent = String(game.minesLeft);
  $('hud-time').textContent = time;
  $('hud-seed-value').textContent = game.seed;
}

// ---------- boot ----------
function boot() {
  const prefs = store.get(PREFS_KEY);
  setSound(prefs?.sound !== false);
  renderer.resize();

  const urlSeed = normalizeSeed(new URL(location.href).searchParams.get('seed'));
  const saved = Game.restore(store.get(SAVE_KEY));
  if (saved && (!urlSeed || urlSeed === saved.seed)) {
    game = saved;
    placeCursor(game.index * 81 + game.start);
    setUrlSeed(game.seed);
  } else {
    startGame(urlSeed || randomSeed());
  }

  if (game.status === 'lost') {
    $('over-text').textContent = `You reached level ${game.index + 1}. Seed ${game.seed}.`;
    openOverlay('over');
  } else {
    showMenu();
  }
  requestAnimationFrame(frame);
}

boot();

// Expose for debugging in the console.
window.gridsweeper = { get game() { return game; }, renderer, COVERED, FLAG, OPEN };
