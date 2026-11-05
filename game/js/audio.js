// Synthesised sound: one AudioContext, a master bus and a music bus, effects,
// ambient wind and a low-health heartbeat. No audio files needed.
const rand = (a, b) => a + Math.random() * (b - a);

let ctx = null, master = null, sfxBus = null, musicBus = null, wind = null;
const vol = { master: 0.8, music: 0.6 };

export function audio() {
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = vol.master; master.connect(ctx.destination);
      sfxBus = ctx.createGain(); sfxBus.connect(master);
      musicBus = ctx.createGain(); musicBus.gain.value = vol.music; musicBus.connect(master);
    } catch (e) { ctx = null; }
  }
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export const musicOut = () => (audio(), musicBus);
export function setVolume(kind, v) {
  vol[kind] = v;
  if (!ctx) return;
  if (kind === 'master') master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
  if (kind === 'music') musicBus.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
}
export function duck(on) { if (ctx) sfxBus.gain.setTargetAtTime(on ? 0.35 : 1, ctx.currentTime, 0.2); }

const noiseCache = new Map();
function noiseBuffer(dur, decay) {
  const key = dur + ':' + decay;
  if (noiseCache.has(key)) return noiseCache.get(key);
  const b = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * dur), ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (decay ? Math.pow(1 - i / d.length, decay) : 1);
  noiseCache.set(key, b); return b;
}
function out(pan) {
  if (pan == null || !ctx.createStereoPanner) return sfxBus;
  const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(sfxBus); return p;
}
function burst(dur, freq, gain, { q = 0.7, type = 'lowpass', decay = 2.5, pan, at = 0 } = {}) {
  if (!audio()) return;
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuffer(dur, decay); f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.value = gain;
  s.connect(f).connect(g).connect(out(pan)); s.start(ctx.currentTime + at);
}
function tone(f0, f1, dur, gain, { type = 'sine', pan, at = 0 } = {}) {
  if (!audio()) return;
  const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + at;
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(g).connect(out(pan)); o.start(t); o.stop(t + dur + 0.02);
}

export const sfx = {
  shot() { burst(0.25, 2600, 0.6); burst(0.5, 500, 0.35, { decay: 4 }); tone(150, 38, 0.14, 0.6); burst(0.9, 1200, 0.07, { decay: 3, at: 0.06, q: 0.4 }); },
  empty() { burst(0.04, 5000, 0.3, { q: 4, type: 'bandpass' }); },
  reload(t = 1.7) { const k = t / 1.7; burst(0.05, 3500, 0.3, { q: 3, type: 'bandpass' }); burst(0.06, 2500, 0.35, { q: 3, type: 'bandpass', at: 0.6 * k }); burst(0.05, 4200, 0.35, { q: 3, type: 'bandpass', at: 1.3 * k }); },
  hit(head) { burst(0.09, head ? 1400 : 900, 0.4, { q: 1.5 }); if (head) tone(1600, 900, 0.07, 0.12, { type: 'triangle' }); },
  kill() { tone(520, 260, 0.12, 0.12, { type: 'triangle' }); },
  hurt() { burst(0.25, 320, 0.8, { q: 1 }); tone(90, 50, 0.2, 0.25); },
  step(run) { burst(0.07, run ? 700 : 500, run ? 0.16 : 0.1, { q: 0.8, decay: 3 }); },
  land() { burst(0.12, 400, 0.3, { decay: 3 }); },
  shove() { burst(0.18, 700, 0.5, { decay: 2 }); tone(120, 60, 0.15, 0.3); },
  pickup() { tone(660, 990, 0.08, 0.12, { type: 'triangle' }); tone(990, 1320, 0.1, 0.1, { type: 'triangle', at: 0.07 }); },
  heal() { tone(440, 660, 0.25, 0.1, { type: 'sine' }); tone(660, 880, 0.3, 0.08, { type: 'sine', at: 0.12 }); },
  upgrade() { [523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.25, 0.09, { type: 'triangle', at: i * 0.07 })); },
  wave() { tone(110, 55, 1.2, 0.35, { type: 'sawtooth' }); burst(1.4, 300, 0.25, { decay: 1.5 }); },
  cleared() { [392, 523, 659].forEach((f, i) => tone(f, f, 0.5, 0.08, { type: 'triangle', at: i * 0.12 })); },
  swipe(pan) { burst(0.15, 1800, 0.25, { type: 'bandpass', q: 1.2, pan }); },
  heartbeat() { tone(70, 40, 0.12, 0.45); tone(70, 40, 0.12, 0.35, { at: 0.18 }); },
  ui() { tone(880, 880, 0.04, 0.05, { type: 'square' }); },
  groan(gain = 0.2, pan) {
    if (!audio()) return;
    const o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = 'sawtooth'; o.frequency.value = rand(65, 115); lfo.frequency.value = rand(4, 8); lg.gain.value = rand(8, 20);
    lfo.connect(lg).connect(o.frequency); f.type = 'lowpass'; f.frequency.value = rand(500, 900);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.25); g.gain.exponentialRampToValueAtTime(0.001, t + rand(0.9, 1.6));
    o.connect(f).connect(g).connect(out(pan)); o.start(t); lfo.start(t); o.stop(t + 1.7); lfo.stop(t + 1.7);
  },
  beat(gain, pan) { tone(110, 42, 0.2, gain, { pan }); burst(0.05, 6000, gain * 0.25, { type: 'highpass', pan, at: 0.24 }); },
};

// a low, gusting wind under everything
export function startWind() {
  if (!audio() || wind) return;
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(4, 0); s.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 380; f.Q.value = 0.6;
  const g = ctx.createGain(); g.gain.value = 0.05;
  const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.08; lg.gain.value = 0.035; lfo.connect(lg).connect(g.gain);
  const lfo2 = ctx.createOscillator(), lg2 = ctx.createGain(); lfo2.frequency.value = 0.05; lg2.gain.value = 180; lfo2.connect(lg2).connect(f.frequency);
  s.connect(f).connect(g).connect(master); s.start(); lfo.start(); lfo2.start();
  wind = { s, g };
}
