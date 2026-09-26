// Unified input: Pointer Events (mouse, touch, pen/stylus), keyboard and the
// Gamepad API all funnel into the same small set of game actions.
//
// h (handlers): {
//   hit(x, y) -> cell id or -1, canPlay() -> bool, overlay() -> open overlay element or null,
//   tap(g), long(g), flag(g), chord(g), hover(g), pressed(g), pan(dx, dy),
//   zoom(dir),
//   move(dr, dc), cursorPrimary(), cursorFlag(), usedPointer(), usedKeys(),
//   command(name)  // 'retry' | 'menu' | 'help' | 'flagMode' | 'back' | 'center' | 'zoomIn' | 'zoomOut'
// }

const LONG_PRESS_MS = 380;
const MOVE_TOLERANCE = 12;

export function setupPointer(canvas, h) {
  let press = null;

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // Capture can throw (e.g. the pointer is already gone); it's only a nicety.
  const capture = (id) => { try { canvas.setPointerCapture(id); } catch { /* ignore */ } };
  const cancelPress = () => {
    if (press?.timer) clearTimeout(press.timer);
    press = null;
    h.pressed(-1);
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    h.usedPointer();
    const { x, y } = pos(e);
    const cell = h.canPlay() ? h.hit(x, y) : -1;

    if (e.pointerType === 'mouse') {
      if (cell < 0) return;
      if (e.button === 2) { h.flag(cell); return; }
      if (e.button === 1) { e.preventDefault(); h.chord(cell); return; }
      if (e.button !== 0) return;
      press = { id: e.pointerId, cell, mouse: true };
      h.pressed(cell);
      capture(e.pointerId);
      return;
    }

    // Stylus barrel button (2) or eraser end (5) flags directly.
    if (e.pointerType === 'pen' && (e.button === 2 || e.button === 5 || (e.buttons & 2) || (e.buttons & 32))) {
      h.flag(cell);
      return;
    }

    // Touch / pen tip: tap, long-press, or drag to pan. A second finger cancels.
    if (press) { cancelPress(); return; }
    capture(e.pointerId);
    press = {
      id: e.pointerId, cell, x, y, lx: x, ly: y, long: false, panning: false,
      timer: cell < 0 ? null : setTimeout(() => {
        if (!press) return;
        press.long = true;
        press.timer = null;
        h.pressed(-1);
        h.long(press.cell);
      }, LONG_PRESS_MS),
    };
    h.pressed(cell);
  });

  canvas.addEventListener('pointermove', (e) => {
    const { x, y } = pos(e);
    if (e.pointerType !== 'touch') h.hover(h.canPlay() ? h.hit(x, y) : -1);
    if (!press || press.id !== e.pointerId) return;
    if (press.mouse) {
      press.cell = h.hit(x, y);
      h.pressed(press.cell);
      return;
    }
    if (!press.panning && !press.long && Math.hypot(x - press.x, y - press.y) > MOVE_TOLERANCE) {
      if (press.timer) clearTimeout(press.timer);
      press.timer = null;
      press.panning = true;
      h.pressed(-1);
    }
    if (press.panning) {
      h.pan(x - press.lx, y - press.ly);
      press.lx = x;
      press.ly = y;
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!press || press.id !== e.pointerId) return;
    const p = press;
    cancelPress();
    if (!p.long && !p.panning && p.cell >= 0 && h.canPlay()) h.tap(p.cell);
  });

  canvas.addEventListener('pointercancel', cancelPress);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') h.hover(-1);
  });

  // The wheel (or a vertical trackpad scroll / pinch) zooms, one level per
  // notch; trackpads send many small deltas, so they're added up first.
  // Horizontal scrolling, or Shift+wheel, pans the board.
  let wheelAcc = 0, wheelAt = 0, wheelStep = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const [dx, dy] = e.shiftKey && !e.deltaX ? [e.deltaY, 0] : [e.deltaX, e.deltaY];
      h.pan(-dx, -dy);
      return;
    }
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1; // lines / pages -> pixels
    if (e.timeStamp - wheelAt > 250) wheelAcc = 0;
    wheelAt = e.timeStamp;
    wheelAcc += e.deltaY * unit;
    // A short pause between steps keeps one trackpad swipe from racing
    // through dozens of levels.
    if (Math.abs(wheelAcc) < 50 || e.timeStamp - wheelStep < 120) return;
    h.zoom(wheelAcc < 0 ? 1 : -1);
    wheelAcc = 0;
    wheelStep = e.timeStamp;
  }, { passive: false });
}

const MOVE_KEYS = {
  ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
  KeyW: [-1, 0], KeyS: [1, 0], KeyA: [0, -1], KeyD: [0, 1],
};

export function setupKeyboard(h) {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const overlay = h.overlay();
    if (overlay) {
      if (e.key === 'Escape') { e.preventDefault(); h.command('back'); }
      return; // let the overlay's buttons/inputs handle everything else natively
    }
    const mv = MOVE_KEYS[e.code];
    if (mv) {
      e.preventDefault();
      h.usedKeys();
      const step = e.shiftKey ? 3 : 1;
      h.move(mv[0] * step, mv[1] * step);
      return;
    }
    switch (e.code) {
      case 'Space': case 'Enter': case 'NumpadEnter': case 'KeyZ': case 'KeyJ':
        e.preventDefault();
        h.usedKeys();
        if (!e.repeat) h.cursorPrimary();
        break;
      case 'KeyF': case 'KeyX': case 'KeyK':
        e.preventDefault();
        h.usedKeys();
        if (!e.repeat) h.cursorFlag();
        break;
      case 'KeyM': if (!e.repeat) h.command('flagMode'); break;
      case 'KeyR': if (!e.repeat) h.command('retry'); break;
      case 'KeyC': h.usedKeys(); h.command('center'); break;
      case 'Equal': case 'NumpadAdd': h.command('zoomIn'); break;
      case 'Minus': case 'NumpadSubtract': h.command('zoomOut'); break;
      case 'Escape': case 'KeyN': e.preventDefault(); h.command('menu'); break;
      case 'F1': case 'Slash': case 'KeyH': e.preventDefault(); h.command('help'); break;
    }
  });
}

// Standard gamepad mapping button indices.
const BTN = { A: 0, B: 1, X: 2, Y: 3, SELECT: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const REPEAT_DELAY = 260, REPEAT_RATE = 85, DEADZONE = 0.5;

export function createGamepadPoller(h) {
  const prev = new Map(); // gamepad index -> pressed button array
  let held = null; // { dir, next }

  function focusStep(overlay, delta) {
    const items = [...overlay.querySelectorAll('button:not([disabled]):not([hidden]), input')]
      .filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    const next = at < 0 ? 0 : (at + delta + items.length) % items.length;
    items[next].focus();
  }

  function direction(gp) {
    const b = (i) => gp.buttons[i]?.pressed;
    const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
    const dr = (b(BTN.DOWN) || ay > DEADZONE ? 1 : 0) - (b(BTN.UP) || ay < -DEADZONE ? 1 : 0);
    const dc = (b(BTN.RIGHT) || ax > DEADZONE ? 1 : 0) - (b(BTN.LEFT) || ax < -DEADZONE ? 1 : 0);
    return dr || dc ? `${dr},${dc}` : null;
  }

  function onDirection(dir) {
    const [dr, dc] = dir.split(',').map(Number);
    const overlay = h.overlay();
    if (overlay) focusStep(overlay, dr + dc > 0 ? 1 : -1);
    else { h.usedKeys(); h.move(dr, dc); }
  }

  function onButton(i) {
    const overlay = h.overlay();
    if (overlay) {
      if (i === BTN.A) {
        const el = overlay.contains(document.activeElement) ? document.activeElement : null;
        if (el?.tagName === 'BUTTON') el.click();
        else focusStep(overlay, 1);
      } else if (i === BTN.B || i === BTN.START) {
        h.command('back');
      }
      return;
    }
    h.usedKeys();
    switch (i) {
      case BTN.A: h.cursorPrimary(); break;
      case BTN.B: case BTN.X: h.cursorFlag(); break;
      case BTN.Y: h.command('flagMode'); break;
      case BTN.SELECT: h.command('retry'); break;
      case BTN.START: h.command('menu'); break;
    }
  }

  return function poll(now) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let dir = null;
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const before = prev.get(gp.index) || [];
      const pressed = gp.buttons.map((b) => b.pressed);
      for (const i of [BTN.A, BTN.B, BTN.X, BTN.Y, BTN.SELECT, BTN.START]) {
        if (pressed[i] && !before[i]) onButton(i);
      }
      prev.set(gp.index, pressed);
      dir = dir || direction(gp);
    }
    if (!dir) { held = null; return; }
    if (!held || held.dir !== dir) {
      held = { dir, next: now + REPEAT_DELAY };
      onDirection(dir);
    } else if (now >= held.next) {
      held.next = now + REPEAT_RATE;
      onDirection(dir);
    }
  };
}
