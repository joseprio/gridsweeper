// Tiny WebAudio synth: no audio files needed.
let ctx = null;
let enabled = true;

function audio() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, { at = 0, dur = 0.08, type = 'triangle', gain = 0.12, slide = 0 } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sound = {
  get enabled() { return enabled; },
  set enabled(v) { enabled = !!v; },
  unlock() { audio(); },
  open(n = 1) { tone(n > 1 ? 620 : 520, { dur: 0.06, gain: 0.08 }); },
  flag(on) { tone(on ? 880 : 660, { dur: 0.07, type: 'square', gain: 0.05 }); },
  boom() {
    const a = audio();
    if (!a) return;
    const len = Math.floor(a.sampleRate * 0.6);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = a.createBufferSource();
    const filter = a.createBiquadFilter();
    const g = a.createGain();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    g.gain.value = 0.5;
    src.buffer = buf;
    src.connect(filter).connect(g).connect(a.destination);
    src.start();
    tone(110, { dur: 0.5, type: 'sine', gain: 0.3, slide: 0.4 });
  },
  clear() {
    [523, 659, 784, 1047].forEach((f, k) => tone(f, { at: k * 0.08, dur: 0.18, gain: 0.1 }));
  },
  zoom() { tone(300, { dur: 0.9, type: 'sine', gain: 0.07, slide: 0.35 }); },
};
