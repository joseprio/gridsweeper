// Canvas renderer. Draws the playable level, the ring of the next level around
// it (hidden next-level cells dimmed), and recursively every previous level
// shrunk into the core.
import { SIZE, CELLS, CORE_LO, isCore, isRing, neighbors } from './level.js';
import { OPEN, FLAG, gid, split } from './game.js';
import { DIGIT_BOX, DIGIT_PATHS } from './digits.js';

const digitCache = [];
const digitPath = (n) => (digitCache[n] ??= new Path2D(DIGIT_PATHS[n]));

const C = {
  bg: '#172030',
  gridBg: '#101722',
  tileMid: '#cdc2a9',
  tileLight: '#f1eadb',
  tileDark: '#857a66',
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
const HIDDEN_ALPHA = 0.3;
const PEEK = 1; // how much of the locked cells past the ring to show, in cells
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
    this.pan = { x: 0, y: 0 };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    // Fit the grid, the whole ring of next-level cells (3 cells deep) and a
    // peek of the locked cells beyond it on every side; the longer side shows
    // more. If that makes cells too small to tap, keep them bigger and let the
    // board be panned instead.
    const full = Math.min(this.w, this.h) / (SIZE + 6 + 2 * PEEK);
    const partial = Math.min(this.w / (SIZE + 2), this.h / (SIZE + 2), 48);
    this.cell = full >= MIN_CELL ? full : Math.max(full, partial);
    this.panBy(0, 0);
  }

  // Board centre on screen.
  get cx() { return this.w / 2 + this.pan.x; }
  get cy() { return this.h / 2 + this.pan.y; }

  // Moves the board, clamped so it can't scroll past the locked-cell peek.
  panBy(dx, dy) {
    const extent = (4.5 + 3 + PEEK) * this.cell;
    const mx = Math.max(0, extent - this.w / 2), my = Math.max(0, extent - this.h / 2);
    const x = Math.max(-mx, Math.min(mx, this.pan.x + dx));
    const y = Math.max(-my, Math.min(my, this.pan.y + dy));
    const moved = x !== this.pan.x || y !== this.pan.y;
    this.pan = { x, y };
    return moved;
  }

  // Pans just enough to bring a cell fully into view (keyboard/gamepad cursor).
  reveal(g, game, margin = 8) {
    const { x, y, size } = this.cellRect(g, game);
    const w = Math.min(size, this.w - 2 * margin), h = Math.min(size, this.h - 2 * margin);
    const dx = x < margin ? margin - x : x + w > this.w - margin ? this.w - margin - (x + w) : 0;
    const dy = y < margin ? margin - y : y + h > this.h - margin ? this.h - margin - (y + h) : 0;
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

    const outerCell = view.cell * 3;
    this.drawLevel(game, view.top + 1, this.cx - 4.5 * outerCell, this.cy - 4.5 * outerCell, outerCell, view, ui);
    this.vignette(this.cx, this.cy, view.cell);
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

  vignette(cx, cy, cell) {
    const { ctx } = this;
    const g = ctx.createRadialGradient(cx, cy, cell * 9, cx, cy, cell * 16);
    g.addColorStop(0, 'rgba(23,32,48,0)');
    g.addColorStop(1, 'rgba(23,32,48,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  // Everything up to the ring is fully shown; the hidden cells of the next
  // level are dim, and fade in while zooming out.
  alpha(game, level, i, e) {
    const p = game.index;
    if (level <= p) return 1;
    if (level === p + 1) return isRing(i) ? 1 : HIDDEN_ALPHA + (1 - HIDDEN_ALPHA) * e;
    if (level === p + 2) return isRing(i) ? e : HIDDEN_ALPHA * e;
    return 0;
  }

  drawLevel(game, level, x0, y0, cell, view, ui) {
    if (level < 0) return;
    const { ctx } = this;
    const span = cell * SIZE;
    if (x0 > this.w || y0 > this.h || x0 + span < 0 || y0 + span < 0) return;

    if (cell < 2.5) {
      // Too small for detail: a flat, averaged block.
      ctx.fillStyle = '#d8cfbc';
      ctx.fillRect(x0, y0, span, span);
      return;
    }

    for (let i = 0; i < CELLS; i++) {
      if (isCore(level, i)) continue;
      const x = x0 + (i % SIZE) * cell, y = y0 + Math.floor(i / SIZE) * cell;
      if (x > this.w || y > this.h || x + cell < 0 || y + cell < 0) continue;
      const a = this.alpha(game, level, i, view.e);
      if (a <= 0.01) continue;
      ctx.globalAlpha = a;
      this.drawCell(game, level, i, x, y, cell, ui);
    }
    ctx.globalAlpha = 1;

    if (level > 0) {
      const cx = x0 + CORE_LO * cell, cy = y0 + CORE_LO * cell;
      ctx.fillStyle = C.gridBg;
      ctx.fillRect(cx + cell * 0.04, cy + cell * 0.04, cell * 3 - cell * 0.08, cell * 3 - cell * 0.08);
      this.drawLevel(game, level - 1, cx, cy, cell / 3, view, ui);
    }
  }

  drawCell(game, level, i, x, y, s, ui) {
    const { ctx } = this;
    const g = gid(level, i);
    const state = game.stateOf(level, i);
    const mine = game.world.mine(level, i);
    const lost = game.status === 'lost';
    const live = game.status === 'playing' && game.isPlayable(level, i);
    const b = this.contentBox(x, y, s);

    if (lost && g === game.exploded) {
      this.tileOpen(x, y, s, C.exploded);
      this.mine(b.x, b.y, b.s);
    } else if (state === FLAG) {
      this.tileCovered(x, y, s);
      this.flag(b.x, b.y, b.s);
      if (lost && !mine) this.cross(b.x, b.y, b.s);
    } else if (state === OPEN) {
      const t0 = ui.openAt.get(g);
      const k = t0 === undefined ? 1 : Math.min(1, Math.max(0, (ui.now - t0) / 140));
      this.tileOpen(x, y, s);
      if (k < 1) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * (1 - k);
        const inset = s * 0.5 * k;
        this.tileCovered(x + inset, y + inset, s - inset * 2);
        ctx.globalAlpha = a;
      } else {
        this.number(b.x, b.y, b.s, game.count(level, i));
      }
    } else if (lost && mine && game.isPlayable(level, i)) {
      this.tileOpen(x, y, s);
      this.mine(b.x, b.y, b.s);
    } else if (live && ui.pressed === g) {
      this.tileOpen(x, y, s);
    } else {
      this.tileCovered(x, y, s);
      if (live && ui.hover === g) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        rrect(ctx, x + s * 0.06, y + s * 0.06, s * 0.88, s * 0.88, s * 0.12);
        ctx.fill();
      }
    }
  }

  // Where to draw a cell's number or flag: the cell itself or, for a big ring
  // cell partly off screen, the part of it that is visible.
  contentBox(x, y, s) {
    const x0 = Math.max(x, 0), x1 = Math.min(x + s, this.w);
    const y0 = Math.max(y, 0), y1 = Math.min(y + s, this.h);
    if (x1 - x0 >= s - 0.5 && y1 - y0 >= s - 0.5) return { x, y, s };
    const size = Math.max(4, Math.min(s, (x1 - x0) * 1.15, (y1 - y0) * 1.15));
    return { x: (x0 + x1) / 2 - size / 2, y: (y0 + y1) / 2 - size / 2, s: size };
  }

  tileCovered(x, y, s) {
    const { ctx } = this;
    const g = s * 0.05;
    const w = s - g * 2;
    if (s < 7) {
      ctx.fillStyle = C.tileMid;
      ctx.fillRect(x + g, y + g, w, w);
      return;
    }
    const r = s * 0.12, b = Math.max(1, s * 0.07);
    ctx.fillStyle = C.tileDark;
    rrect(ctx, x + g, y + g, w, w, r);
    ctx.fill();
    ctx.fillStyle = C.tileLight;
    rrect(ctx, x + g, y + g, w - b, w - b, r);
    ctx.fill();
    ctx.fillStyle = C.tileMid;
    rrect(ctx, x + g + b * 0.8, y + g + b * 0.8, w - b * 1.8, w - b * 1.8, r * 0.8);
    ctx.fill();
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
