// Canvas renderer. Draws the playable level, the ring of the next level around
// it (hidden next-level cells dimmed), and recursively every previous level
// shrunk into the core.
import { SIZE, CELLS, CORE_LO, isCore, isRing, neighbors } from './level.js';
import { OPEN, FLAG, gid, split } from './game.js';
import { DIGIT_BOX, DIGIT_PATHS } from './digits.js';

const digitCache = [];
const digitPath = (n) => (digitCache[n] ??= new Path2D(DIGIT_PATHS[n]));

const C = {
  bg: '#283041', // navy, shows in the gaps between cells
  gridBg: '#101722',
  // Covered cells, after the title image: flat face and a mitred bevel lit
  // warm from the top-left and reflecting blue on the bottom-right.
  tileFace: '#b9ae9b',
  tileTop: '#d6cfbd',
  tileLeft: '#e0d4a6',
  tileRight: '#3e6694',
  tileBottom: '#6c849c',
  tileOutline: 'rgba(8,10,14,0.85)',
  openMid: '#e9e3d4',
  openEdge: '#b6ad98',
  exploded: '#e2474b',
  flagRed: '#ef3b3f',
  flagDark: '#263042',
  mine: '#1d2330',
  cursor: '#ffd23f',
  influence: 'rgba(255,196,64,0.32)',
  influenceEdge: 'rgba(255,196,64,0.95)',
};
const LOCKED_SHADE = 0.7; // how much locked cells are darkened (towards the background)
const PEEK = 0.6; // how much of the locked cells past the ring to show, in cells (a fifth of one)
const MIN_CELL = 34; // smallest comfortable cell before the board pans instead

const NUM_COLORS = [null, '#23a8dc', '#2dbd4e', '#e2353b', '#2a45c8', '#9c2b2a', '#1c9c95', '#2b2b2b', '#7b7b7b'];
const NUM_SHADOWS = NUM_COLORS.map((c) => c && shade(c, 0.55));

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.cell = 32;
    this.sprites = new Map(); // tile images per kind and pixel size, see sprite()
    this.vig = null; // cached darkening of locked cells and screen edges, see shade()
    this.pan = { x: 0, y: 0 };
    this.insets = { left: 0, top: 0, right: 0, bottom: 0 };
    this.area = { x: 0, y: 0, w: 0, h: 0 };
  }

  // Parts of the canvas covered by other UI (the translucent toolbar). The
  // board is sized and centred in the rest, but still drawn underneath.
  setInsets(insets) {
    this.insets = insets;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.sprites.clear(); // the pixel ratio may have changed
    const { left, top, right, bottom } = this.insets;
    this.area = { x: left, y: top, w: Math.max(1, this.w - left - right), h: Math.max(1, this.h - top - bottom) };
    const { w, h } = this.area;
    // Fit the grid, the whole ring of next-level cells (3 cells deep) and a
    // peek of the locked cells beyond it on every side; the longer side shows
    // more. If that makes cells too small to tap, keep them bigger and let the
    // board be panned instead.
    const full = Math.min(w, h) / (SIZE + 6 + 2 * PEEK);
    const partial = Math.min(w / (SIZE + 2), h / (SIZE + 2), 48);
    this.cell = full >= MIN_CELL ? full : Math.max(full, partial);
    this.panBy(0, 0);
  }

  // Board centre on screen.
  get cx() { return this.area.x + this.area.w / 2 + this.pan.x; }
  get cy() { return this.area.y + this.area.h / 2 + this.pan.y; }

  // Moves the board, clamped so it can't scroll past the locked-cell peek.
  panBy(dx, dy) {
    const extent = (4.5 + 3 + PEEK) * this.cell;
    const mx = Math.max(0, extent - this.area.w / 2), my = Math.max(0, extent - this.area.h / 2);
    const x = Math.max(-mx, Math.min(mx, this.pan.x + dx));
    const y = Math.max(-my, Math.min(my, this.pan.y + dy));
    const moved = x !== this.pan.x || y !== this.pan.y;
    this.pan = { x, y };
    return moved;
  }

  // Pans just enough to bring a cell fully into view (keyboard/gamepad cursor).
  reveal(g, game, margin = 8) {
    const { x, y, size } = this.cellRect(g, game);
    const A = this.area;
    const left = A.x + margin, right = A.x + A.w - margin, top = A.y + margin, bottom = A.y + A.h - margin;
    const w = Math.min(size, right - left), h = Math.min(size, bottom - top);
    const dx = x < left ? left - x : x + w > right ? right - (x + w) : 0;
    const dy = y < top ? top - y : y + h > bottom ? bottom - (y + h) : 0;
    return this.panBy(dx, dy);
  }

  // Screen position -> global cell id (current level, the ring around it, or a
  // solved cell of the level below, for chording), or -1.
  hit(px, py, game) {
    const c = this.cell;
    const u = (px - (this.cx - 4.5 * c)) / c;
    const v = (py - (this.cy - 4.5 * c)) / c;
    return this.cellAtUnits(u, v, game.index, true);
  }

  // (u, v) in current-level cell units, origin at the grid's top-left corner.
  cellAtUnits(u, v, p, includeLower = false) {
    if (u >= 0 && u < SIZE && v >= 0 && v < SIZE) {
      const i = Math.floor(v) * SIZE + Math.floor(u);
      if (!isCore(p, i)) return gid(p, i);
      if (!includeLower) return -1;
      const j = Math.floor((v - CORE_LO) * 3) * SIZE + Math.floor((u - CORE_LO) * 3);
      return isCore(p - 1, j) ? -1 : gid(p - 1, j);
    }
    const U = Math.floor((u + 9) / 3), V = Math.floor((v + 9) / 3);
    if (U < 0 || V < 0 || U >= SIZE || V >= SIZE) return -1;
    const j = V * SIZE + U;
    return isRing(j) ? gid(p + 1, j) : -1;
  }

  // Screen rectangle of any cell. `view` defaults to the level being played.
  rectOf(level, i, view) {
    const s = view.cell * 3 ** (level - view.top);
    const x0 = this.cx - 4.5 * s, y0 = this.cy - 4.5 * s;
    return { x: x0 + (i % SIZE) * s, y: y0 + Math.floor(i / SIZE) * s, size: s };
  }

  cellRect(g, game) {
    const [l, i] = split(g);
    return this.rectOf(l, i, { top: game.index, cell: this.cell });
  }

  // view: { top, cell, e }: `top` is the level whose grid is centred with
  // cells of size `cell`; e is the zoom-out progress (0 when not zooming).
  // ui: { now, hover, pressed, cursor, showCursor, openAt: Map }
  draw(game, view, ui) {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const outerCell = view.cell * 9;
    this.drawLevel(game, view.top + 2, this.cx - 4.5 * outerCell, this.cy - 4.5 * outerCell, outerCell, view, ui);
    this.shade(view);
    if (view.e || game.status !== 'playing') return;

    // The cell under the finger/pointer/cursor, and every neighbour of it that
    // could be hiding a mine (anything not opened, on any level).
    const focus = ui.pressed >= 0 ? ui.pressed : ui.hover >= 0 ? ui.hover : ui.showCursor ? ui.cursor : -1;
    if (focus >= 0) this.drawInfluence(game, focus, view);

    if (ui.showCursor && ui.cursor >= 0) {
      const { x, y, size } = this.cellRect(ui.cursor, game);
      const pulse = 0.75 + 0.25 * Math.sin(ui.now / 180);
      ctx.save();
      ctx.strokeStyle = C.cursor;
      ctx.globalAlpha = pulse;
      ctx.lineWidth = Math.max(2, this.cell * 0.08);
      ctx.shadowColor = C.cursor;
      ctx.shadowBlur = this.cell * 0.3;
      rrect(ctx, x + 1, y + 1, size - 2, size - 2, this.cell * 0.16);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawInfluence(game, g, view) {
    const [l, i] = split(g);
    if (!game.isVisible(l, i)) return;
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = Math.max(1.5, this.cell * 0.06);
    for (const [dl, j] of neighbors(l, i)) {
      if (game.stateOf(l + dl, j) === OPEN) continue;
      const { x, y, size } = this.rectOf(l + dl, j, view);
      const inset = Math.min(size, this.cell) * 0.07;
      rrect(ctx, x + inset, y + inset, size - 2 * inset, size - 2 * inset, Math.min(size, this.cell) * 0.14);
      ctx.fillStyle = C.influence;
      ctx.fill();
      ctx.strokeStyle = C.influenceEdge;
      ctx.stroke();
    }
    const { x, y, size } = this.rectOf(l, i, view);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    rrect(ctx, x + 1, y + 1, size - 2, size - 2, Math.min(size, this.cell) * 0.14);
    ctx.stroke();
    ctx.restore();
  }

  // Darkens what isn't playable. Locked cells get darker with a soft gradient
  // where they meet the playable area (the grid plus the ring around it), and
  // everything fades gently towards the screen edges. While zooming out, the
  // next playable area brightens as it comes into play. It's all smooth, so
  // it's rendered at quarter resolution into a cached image and stretched,
  // and only redone when the view moves or zooms.
  shade(view) {
    const { cx, cy } = this;
    const e = view.e;
    const cp = e ? view.cell / 3 : view.cell; // cell size of the level being played
    const key = `${this.w}x${this.h}|${cx.toFixed(1)},${cy.toFixed(1)}|${cp.toFixed(3)}|${e.toFixed(4)}`;
    if (this.vig?.key !== key) {
      const k = e ? 0.15 : 0.25; // coarser while zooming: it's recomputed every frame then
      const W = Math.max(1, Math.ceil(this.w * k)), H = Math.max(1, Math.ceil(this.h * k));
      const img = this.vig?.img ?? document.createElement('canvas');
      img.width = W;
      img.height = H;
      const v = img.getContext('2d');
      const data = v.createImageData(W, H);
      const px = data.data;
      // Playable area now (half-size h0) and after the zoom (h1), with the
      // width of the gradient at each edge (half a locked cell).
      const h0 = 7.5 * cp, f0 = 1.5 * cp, h1 = 22.5 * cp, f1 = 4.5 * cp;
      const r0 = 13.5 * view.cell, rw = 12 * view.cell; // edge fade
      const ramp = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
      const outside = (ax, ay, h) => Math.hypot(Math.max(ax - h, 0), Math.max(ay - h, 0));
      for (let y = 0; y < H; y++) {
        const dy = (y + 0.5) / k - cy, ay = Math.abs(dy);
        for (let x = 0; x < W; x++) {
          const dx = (x + 0.5) / k - cx, ax = Math.abs(dx);
          const locked = LOCKED_SHADE * Math.max(ramp(outside(ax, ay, h0) / f0) * (1 - e), ramp(outside(ax, ay, h1) / f1));
          const edge = 0.6 * Math.min(1, Math.max(0, (Math.hypot(dx, dy) - r0) / rw));
          const i = (y * W + x) * 4;
          px[i] = 40;
          px[i + 1] = 48;
          px[i + 2] = 65;
          px[i + 3] = Math.round(255 * (1 - (1 - locked) * (1 - edge)));
        }
      }
      v.putImageData(data, 0, 0);
      this.vig = { key, img };
    }
    this.ctx.drawImage(this.vig.img, 0, 0, this.w, this.h);
  }







  drawLevel(game, level, x0, y0, cell, view, ui) {
    if (level < 0) return;
    const { ctx } = this;
    const span = cell * SIZE;
    if (x0 > this.w || y0 > this.h || x0 + span < 0 || y0 + span < 0) return;

    if (cell < 0.5) {
      // Sub-pixel cells (the whole level is a few pixels): a flat, averaged
      // block. Anything bigger is drawn cell by cell, as tiny coloured squares.
      ctx.fillStyle = '#d8cfbc';
      ctx.fillRect(x0, y0, span, span);
      return;
    }

    for (let i = 0; i < CELLS; i++) {
      if (isCore(level, i)) continue;
      const x = x0 + (i % SIZE) * cell, y = y0 + Math.floor(i / SIZE) * cell;
      if (x > this.w || y > this.h || x + cell < 0 || y + cell < 0) continue;
      this.drawCell(game, level, i, x, y, cell, ui);
    }

    if (level > 0) {
      const cx = x0 + CORE_LO * cell, cy = y0 + CORE_LO * cell;
      ctx.fillStyle = C.gridBg;
      ctx.fillRect(cx + cell * 0.04, cy + cell * 0.04, cell * 3 - cell * 0.08, cell * 3 - cell * 0.08);
      this.drawLevel(game, level - 1, cx, cy, cell / 3, view, ui);
    }
  }

  // Draws a tile through a cache of pre-rendered images, one per kind and
  // pixel size. The bevels, digit paths and clipping are drawn once per size
  // instead of for every cell on every frame, which keeps animations smooth.
  sprite(key, x, y, s, paint) {
    if (s < 7) {
      // Tiny tiles are a single rectangle anyway.
      this.ctx.save();
      this.ctx.translate(x, y);
      paint();
      this.ctx.restore();
      return;
    }
    const px = Math.max(1, Math.round(s * this.dpr));
    const id = `${key}|${px}`;
    let img = this.sprites.get(id);
    if (!img) {
      if (this.sprites.size > 300) this.sprites.clear(); // sizes churn while zooming
      img = document.createElement('canvas');
      img.width = img.height = px;
      const main = this.ctx;
      this.ctx = img.getContext('2d');
      this.ctx.scale(px / s, px / s);
      try { paint(); } finally { this.ctx = main; }
      this.sprites.set(id, img);
    }
    this.ctx.drawImage(img, x, y, s, s);
  }

  drawCell(game, level, i, x, y, s, ui) {
    const { ctx } = this;
    const g = gid(level, i);
    const state = game.stateOf(level, i);
    const mine = game.world.mine(level, i);
    const lost = game.status === 'lost';
    const live = game.status === 'playing' && game.isPlayable(level, i);
    // Keep numbers and flags readable on partly hidden cells the player can
    // use; locked cells just draw theirs in place, cut off if need be.
    const b = game.isVisible(level, i) ? this.contentBox(x, y, s) : { x, y, s };

    if (lost && g === game.exploded) {
      this.tileOpen(x, y, s, C.exploded);
      this.mine(b.x, b.y, b.s);
    } else if (state === FLAG) {
      if (b.s === s) this.sprite('flag', x, y, s, () => { this.tileCovered(0, 0, s); this.flag(0, 0, s); });
      else { this.tileCovered(x, y, s); this.flag(b.x, b.y, b.s); }
      if (lost && !mine) this.cross(b.x, b.y, b.s);
    } else if (state === OPEN) {
      const t0 = ui.openAt.get(g);
      const k = t0 === undefined ? 1 : Math.min(1, Math.max(0, (ui.now - t0) / 140));
      const n = game.count(level, i);
      if (k >= 1 && b.s === s) {
        this.sprite(`open${n}`, x, y, s, () => { this.tileOpen(0, 0, s); this.number(0, 0, s, n); });
        return;
      }
      this.sprite('open0', x, y, s, () => this.tileOpen(0, 0, s));
      if (k < 1) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * (1 - k);
        const inset = s * 0.5 * k;
        this.tileCovered(x + inset, y + inset, s - inset * 2);
        ctx.globalAlpha = a;
      } else {
        this.number(b.x, b.y, b.s, n);
      }
    } else if (lost && mine && game.isPlayable(level, i)) {
      this.tileOpen(x, y, s);
      this.mine(b.x, b.y, b.s);
    } else if (live && ui.pressed === g) {
      this.tileOpen(x, y, s);
    } else {
      this.sprite('covered', x, y, s, () => this.tileCovered(0, 0, s));
      if (live && ui.hover === g) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        rrect(ctx, x + s * 0.035, y + s * 0.035, s * 0.93, s * 0.93, s * 0.05);
        ctx.fill();
      }
    }
  }

  // Where to draw a cell's number or flag: the cell itself or, for a big ring
  // cell partly off screen or under the toolbar, the part of it that is visible.
  contentBox(x, y, s) {
    const A = this.area;
    const x0 = Math.max(x, A.x), x1 = Math.min(x + s, A.x + A.w);
    const y0 = Math.max(y, A.y), y1 = Math.min(y + s, A.y + A.h);
    if (x1 - x0 >= s - 0.5 && y1 - y0 >= s - 0.5) return { x, y, s };
    if (x1 <= x0 || y1 <= y0) return { x, y, s }; // entirely under the toolbar
    const size = Math.max(4, Math.min(s, (x1 - x0) * 1.15, (y1 - y0) * 1.15));
    return { x: (x0 + x1) / 2 - size / 2, y: (y0 + y1) / 2 - size / 2, s: size };
  }

  // Covered cell: four bevel strips joined diagonally at the corners around a
  // flat face, clipped to a slightly rounded square, with a thin dark outline.
  tileCovered(x, y, s) {
    const { ctx } = this;
    const g = s * 0.035;
    const w = s - g * 2;
    const x0 = x + g, y0 = y + g, x1 = x0 + w, y1 = y0 + w;
    if (s < 7) {
      ctx.fillStyle = C.tileFace;
      ctx.fillRect(x0, y0, w, w);
      return;
    }
    const b = Math.max(1.5, w * 0.075), r = w * 0.05;
    const ix0 = x0 + b, iy0 = y0 + b, ix1 = x1 - b, iy1 = y1 - b;
    const strip = (color, ax, ay, bx, by, cx, cy, dx, dy) => {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx, cy);
      ctx.lineTo(dx, dy);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    ctx.save();
    rrect(ctx, x0, y0, w, w, r);
    ctx.clip();
    strip(C.tileTop, x0, y0, x1, y0, ix1, iy0, ix0, iy0);
    strip(C.tileLeft, x0, y0, ix0, iy0, ix0, iy1, x0, y1);
    strip(C.tileRight, x1, y0, x1, y1, ix1, iy1, ix1, iy0);
    strip(C.tileBottom, x0, y1, ix0, iy1, ix1, iy1, x1, y1);
    ctx.fillStyle = C.tileFace;
    ctx.fillRect(ix0, iy0, ix1 - ix0, iy1 - iy0);
    ctx.restore();
    ctx.strokeStyle = C.tileOutline;
    ctx.lineWidth = Math.max(1, s * 0.018);
    rrect(ctx, x0, y0, w, w, r);
    ctx.stroke();
  }


  tileOpen(x, y, s, color = C.openMid) {
    const { ctx } = this;
    const g = s * 0.05;
    const w = s - g * 2;
    if (s < 7) {
      ctx.fillStyle = color;
      ctx.fillRect(x + g, y + g, w, w);
      return;
    }
    const r = s * 0.1, b = Math.max(1, s * 0.05);
    ctx.fillStyle = C.openEdge;
    rrect(ctx, x + g, y + g, w, w, r);
    ctx.fill();
    ctx.fillStyle = color;
    rrect(ctx, x + g + b, y + g + b, w - b, w - b, r);
    ctx.fill();
  }

  number(x, y, s, n) {
    if (!n) return;
    const { ctx } = this;
    if (s < 6) {
      ctx.fillStyle = NUM_COLORS[n];
      ctx.fillRect(x + s * 0.3, y + s * 0.3, s * 0.4, s * 0.4);
      return;
    }
    // Digit shapes from ref/, scaled so the glyph is ~62% of the cell tall,
    // with a darker copy offset down-right for the raised look.
    const k = (s * 0.62) / DIGIT_BOX.height;
    const d = Math.max(1, s * 0.04);
    const path = digitPath(n);
    for (const [off, color] of [[d, NUM_SHADOWS[n]], [0, NUM_COLORS[n]]]) {
      ctx.save();
      ctx.translate(x + s / 2 + off, y + s / 2 + off);
      ctx.scale(k, k);
      ctx.translate(-DIGIT_BOX.cx, -DIGIT_BOX.cy);
      ctx.fillStyle = color;
      ctx.fill(path);
      ctx.restore();
    }
  }

  flag(x, y, s) {
    const { ctx } = this;
    if (s < 6) {
      ctx.fillStyle = C.flagRed;
      ctx.fillRect(x + s * 0.3, y + s * 0.3, s * 0.4, s * 0.4);
      return;
    }
    const u = s / 100;
    ctx.fillStyle = C.flagDark;
    // base
    ctx.beginPath();
    ctx.moveTo(x + 26 * u, y + 80 * u);
    ctx.lineTo(x + 74 * u, y + 80 * u);
    ctx.lineTo(x + 68 * u, y + 70 * u);
    ctx.lineTo(x + 32 * u, y + 70 * u);
    ctx.closePath();
    ctx.fill();
    // pole
    ctx.fillRect(x + 46 * u, y + 24 * u, 7 * u, 48 * u);
    // pennant
    ctx.fillStyle = C.flagRed;
    ctx.beginPath();
    ctx.moveTo(x + 53 * u, y + 20 * u);
    ctx.lineTo(x + 53 * u, y + 52 * u);
    ctx.lineTo(x + 24 * u, y + 38 * u);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(x + 53 * u, y + 20 * u);
    ctx.lineTo(x + 53 * u, y + 32 * u);
    ctx.lineTo(x + 34 * u, y + 34 * u);
    ctx.closePath();
    ctx.fill();
  }

  mine(x, y, s) {
    const { ctx } = this;
    const cx = x + s / 2, cy = y + s / 2, r = s * 0.2;
    ctx.fillStyle = C.mine;
    ctx.strokeStyle = C.mine;
    ctx.lineWidth = Math.max(1, s * 0.06);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 4;
      ctx.moveTo(cx + Math.cos(a) * r * 1.55, cy + Math.sin(a) * r * 1.55);
      ctx.lineTo(cx - Math.cos(a) * r * 1.55, cy - Math.sin(a) * r * 1.55);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }

  cross(x, y, s) {
    const { ctx } = this;
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = Math.max(1.5, s * 0.07);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + s * 0.22, y + s * 0.22);
    ctx.lineTo(x + s * 0.78, y + s * 0.78);
    ctx.moveTo(x + s * 0.78, y + s * 0.22);
    ctx.lineTo(x + s * 0.22, y + s * 0.78);
    ctx.stroke();
  }
}
