# gridsweeper

An endless minesweeper that zooms out. You start on a 9×9 grid. When you clear it, the camera pulls back and your grid becomes the **centre 3×3 block** of a new 9×9 grid. Around the edge you can always see the ring of blocks that comes next.

## Run it

It's plain JavaScript (ES modules) with no build step and no dependencies. It needs to be served over HTTP, because browsers block modules on `file://`:

```sh
npm start          # http://localhost:8080 (set PORT to change it)
npm test           # node's built-in test runner
```

Any static host works (GitHub Pages, Netlify, `python -m http.server`, …).

## Rules

- Level 1 is a 9×9 grid with 10 mines.
- Every later level is a 9×9 grid whose centre 3×3 *is* the level you just cleared. Those cells hold no mines and no numbers. The other 72 cells get 10 + level mines, up to a maximum of 16.
- Around the grid you're playing is a ring of the next level's cells (3× bigger). They are playable too: open them, flag them, or lose on them. The next level's cells further out stay hidden until you get there.
- Two cells are neighbours when they touch, even at the corner and even across levels. An edge cell counts the big ring cells beside it, and a ring cell counts every small edge cell along its side. So numbers on the edge of your grid include ring mines, and vice versa.
- You clear a level by opening all of its safe cells. The ring is optional, but whatever you open or flag there stays when you zoom out.
- Each level opens a blank area for free, next to the previous grid when possible.
- Layouts are checked by a logic solver, so every level can be finished without guessing (using the ring where needed).
- If you hit a mine you can retry the level from where it started, or start a new game.

## Seeds

A game is defined by its seed. Level *n* draws its candidate layouts from `hash("gridsweeper:" + seed + ":" + n)` (cyrb128 + sfc32). Level *n*'s mines change the numbers on level *n−1*, so levels are generated in order and each one is picked to keep the previous one guess-free. The same seed gives the same mines on every device. Click the seed in the HUD to copy a share link (`?seed=ABC123`). Seeds are case-insensitive.

## Controls

|          | Open / chord | Flag |
|----------|--------------|------|
| Mouse    | Left click (middle click chords) | Right click |
| Touch    | Tap | Long press, or turn on **Flag mode** |
| Stylus   | Tap | Barrel button, eraser, or long press |
| Keyboard | Arrows / WASD to move (Shift = 3 cells), Space / Enter | F or X |
| Gamepad  | D-pad / left stick to move, A | B or X |

Other keys: M toggles flag mode, R retries the level, Esc / N opens the menu, H shows help. On a gamepad, Y toggles flag mode, Select retries and Start opens the menu. The D-pad and A also work in menus.

Progress, your best level and the sound setting are saved in `localStorage`.

## Code

| File | What it does |
|------|--------------|
| `src/rng.js` | Seed hashing, PRNG and seed helpers |
| `src/level.js` | Cross-level geometry (which cells touch), chained layout generation and the no-guess solver |
| `src/game.js` | Game state: the stack of levels, reveal/flag/chord, save and restore |
| `src/render.js` | Canvas renderer: draws levels recursively, plus the next-level preview ring |
| `src/input.js` | Pointer Events (mouse, touch, pen), keyboard and Gamepad API |
| `src/sound.js` | Small WebAudio synth |
| `src/main.js` | Wires it all together: overlays, HUD, zoom animation, persistence |
