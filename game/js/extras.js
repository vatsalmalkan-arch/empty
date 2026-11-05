// Collectible music discs, a small generative music engine, and the phone you
// doom-scroll on to heal.
import * as THREE from 'three';

const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- tracks
// Each disc has an original, generated track. To use your own music instead,
// put an MP3 at assets/music/track-1.mp3 … track-6.mp3; it plays in place of
// the generated one.
export const TRACKS = [
  { name: 'Ashfall', bpm: 84, root: 45, scale: [0, 3, 5, 7, 10], wave: 'sawtooth', color: '#c8352b' },
  { name: 'Static Hymn', bpm: 70, root: 50, scale: [0, 2, 3, 7, 8], wave: 'triangle', color: '#5d9cec' },
  { name: 'Grey Choir', bpm: 96, root: 43, scale: [0, 3, 7, 8, 10], wave: 'square', color: '#9be15d' },
  { name: 'Last Signal', bpm: 110, root: 48, scale: [0, 2, 5, 7, 9], wave: 'sawtooth', color: '#e0b400' },
  { name: 'Rust Waltz', bpm: 90, root: 41, scale: [0, 1, 5, 7, 8], wave: 'triangle', color: '#d9773a' },
  { name: 'Low Tide', bpm: 76, root: 47, scale: [0, 3, 5, 6, 10], wave: 'square', color: '#b37fe0' },
];

export function createMusic(ctxFn, destFn) {
  let timer = 0, current = -1, master = null, file = null, step = 0, nextT = 0, seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function note(a, t, freq, dur, type, gain, cutoff) {
    const o = a.createOscillator(), g = a.createGain(), f = a.createBiquadFilter();
    o.type = type; o.frequency.value = freq; f.type = 'lowpass'; f.frequency.value = cutoff;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function hat(a, t, gain) {
    const n = a.createBuffer(1, a.sampleRate * 0.05, a.sampleRate), d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    s.buffer = n; f.type = 'highpass'; f.frequency.value = 6000; g.gain.value = gain; s.connect(f).connect(g).connect(master); s.start(t);
  }
  function schedule() {
    const a = ctxFn(); if (!a || current < 0) return;
    const tr = TRACKS[current], spb = 60 / tr.bpm / 2;              // eighth notes
    while (nextT < a.currentTime + 0.2) {
      const bar = Math.floor(step / 8) % 4, s = step % 8;
      const chord = [0, 3, 4, 2][bar], deg = (k) => tr.scale[(chord + k) % tr.scale.length] + 12 * Math.floor((chord + k) / tr.scale.length);
      if (s === 0 || s === 4) note(a, nextT, hz(tr.root - 12 + deg(0)), spb * 3.5, 'triangle', 0.22, 600);          // bass
      if (s === 0) for (const k of [0, 2, 4]) note(a, nextT, hz(tr.root + 12 + deg(k)), spb * 7.5, tr.wave, 0.035, 1100);   // pad
      if (rnd() < 0.7) note(a, nextT, hz(tr.root + 24 + deg((rnd() * 5) | 0)), spb * 0.9, 'square', 0.03, 2400);           // arpeggio
      if (s % 2 === 1) hat(a, nextT, 0.04);
      nextT += spb; step++;
    }
  }
  function stop() {
    clearInterval(timer); timer = 0;
    if (file) { file.pause(); file = null; }
    if (master) { const a = ctxFn(), m = master; m.gain.setTargetAtTime(0, a.currentTime, 0.4); setTimeout(() => m.disconnect(), 2000); master = null; }
  }
  function play(i) {
    const a = ctxFn(); if (!a) return;
    stop(); current = i; seed = 1000 + i * 977; step = 0;
    const el = new Audio(`./assets/music/track-${i + 1}.mp3`);
    el.loop = true; el.volume = 0.55;
    let usedFile = false;
    el.addEventListener('canplay', () => { if (current === i && !usedFile) { usedFile = true; clearInterval(timer); timer = 0; if (master) { master.disconnect(); master = null; } file = el; el.play().catch(() => {}); } }, { once: true });
    el.load();
    master = a.createGain(); master.gain.value = 0.9; master.connect(destFn ? destFn() : a.destination);
    nextT = a.currentTime + 0.1; timer = setInterval(schedule, 40);
  }
  return { play, stop, get current() { return current; } };
}

// ---------------------------------------------------------------- discs
function discTexture(color) {
  // a 16 x 16 pixel-art record
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const x = c.getContext('2d');
  for (let py = 0; py < 16; py++) for (let px = 0; px < 16; px++) {
    const d = Math.hypot(px - 7.5, py - 7.5);
    if (d > 7.6) continue;
    x.fillStyle = d < 1.2 ? '#0d0d0f' : d < 3.2 ? color : (Math.round(d) % 2 ? '#1c1c20' : '#2a2a30');
    if (d > 3.2 && d < 7 && (px + py) % 7 === 0) x.fillStyle = '#4a4a52';               // sheen
    x.fillRect(px, py, 1, 1);
  }
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createDiscs(scene, heightAt, avoid) {
  const discs = [];
  TRACKS.forEach((tr, i) => {
    let x = 0, z = 0;
    for (let k = 0; k < 60; k++) {
      const a = Math.random() * Math.PI * 2, r = rand(12, 46); x = Math.cos(a) * r; z = Math.sin(a) * r;
      if (avoid.every((c) => Math.hypot(c.x - x, c.z - z) > c.r + 1.2) && discs.every((d) => Math.hypot(d.x - x, d.z - z) > 12)) break;
    }
    const y = heightAt(x, z);
    const g = new THREE.Group(); g.position.set(x, y, z);
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: discTexture(tr.color), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, fog: false }));
    disc.position.y = 1.2; g.add(disc);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.25, 30, 8, 1, true), new THREE.MeshBasicMaterial({ color: tr.color, transparent: true, opacity: 0.12, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
    beam.position.y = 15; g.add(beam);
    const light = new THREE.PointLight(new THREE.Color(tr.color), 3, 6, 1.8); light.position.y = 1.3; g.add(light);
    scene.add(g);
    discs.push({ i, x, z, g, disc, beam, light, taken: false });
  });
  function update(t, player) {
    let picked = -1;
    for (const d of discs) {
      if (d.taken) continue;
      d.disc.rotation.y = t * 1.6; d.disc.position.y = 1.2 + Math.sin(t * 2 + d.i) * 0.12;
      d.beam.material.opacity = 0.09 + 0.05 * Math.sin(t * 3 + d.i);
      if (Math.hypot(player.x - d.x, player.z - d.z) < 1.6) { d.taken = true; d.disc.visible = d.beam.visible = false; d.light.intensity = 0; picked = d.i; }
    }
    return picked;
  }
  function reset() { for (const d of discs) if (d.taken) { d.taken = false; d.disc.visible = d.beam.visible = true; d.light.intensity = 3; } }
  return { discs, update, reset, get found() { return discs.filter((d) => d.taken).length; } };
}

// ---------------------------------------------------------------- phone
function feedCanvas() {
  const c = document.createElement('canvas'); c.width = 180; c.height = 360;
  return c;
}
const POSTS = Array.from({ length: 24 }, (_, i) => ({ h: rand(90, 170), hue: (i * 47) % 360, lines: 1 + ((Math.random() * 3) | 0), likes: (Math.random() * 99) | 0 }));
function drawFeed(c, scroll) {
  const x = c.getContext('2d'), W = c.width, H = c.height;
  x.fillStyle = '#0e0f12'; x.fillRect(0, 0, W, H);
  let y = 34 - (scroll % 2600);
  for (let k = 0; y < H; k++) {
    const p = POSTS[k % POSTS.length];
    if (y + p.h > 0) {
      x.fillStyle = '#1b1d22'; x.fillRect(8, y, W - 16, p.h - 8);
      x.fillStyle = `hsl(${p.hue} 55% 55%)`; x.fillRect(14, y + 24, W - 28, p.h - 62);
      x.fillStyle = `hsl(${(p.hue + 40) % 360} 60% 70%)`; x.beginPath(); x.arc(22, y + 12, 7, 0, 7); x.fill();
      x.fillStyle = '#5a5f68'; x.fillRect(34, y + 9, 60, 6);
      x.fillStyle = '#7d828c'; for (let l = 0; l < p.lines; l++) x.fillRect(14, y + p.h - 32 + l * 8, W - 40 - l * 18, 4);
      x.fillStyle = '#ff5a6e'; x.fillText('♥ ' + p.likes + 'k', W - 52, y + 14);
    }
    y += p.h;
  }
  x.fillStyle = '#0e0f12'; x.fillRect(0, 0, W, 26);
  x.fillStyle = '#e8e8ea'; x.font = 'bold 12px sans-serif'; x.fillText('For you', 12, 18);
  x.fillStyle = '#9be15d'; x.fillText('+HP', W - 40, 18);
}

export function createPhone(camera, model) {
  const root = new THREE.Group();
  camera.add(root);
  // stand the phone up with its thinnest side facing the camera, about 15 cm tall
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  const holder = new THREE.Group(); holder.add(model); model.position.sub(centre);
  const dims = [size.x, size.y, size.z], thin = dims.indexOf(Math.min(...dims)), tall = dims.indexOf(Math.max(...dims));
  if (thin === 0) holder.rotation.y = Math.PI / 2; else if (thin === 1) holder.rotation.x = Math.PI / 2;
  if ((thin === 2 && tall === 0) || (thin === 1 && tall === 0) || (thin === 0 && tall === 2)) holder.rotation.z = Math.PI / 2;
  const s = 0.15 / Math.max(...dims); holder.scale.setScalar(s);
  root.add(holder);
  model.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.material.fog = false; } });
  // the screen: a live feed drawn on a canvas
  const can = feedCanvas(), tex = new THREE.CanvasTexture(can); tex.colorSpace = THREE.SRGBColorSpace;
  const thick = Math.min(...dims) * s, w = (dims.filter((_, i) => i !== thin && i !== tall)[0] || size.x) * s;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.86, 0.15 * 0.84), new THREE.MeshBasicMaterial({ map: tex, fog: false, toneMapped: false }));
  screen.position.z = thick / 2 + 0.002; root.add(screen);
  const glow = new THREE.PointLight(0x9fc3ff, 0, 0.6); glow.position.z = 0.08; root.add(glow);
  let raise = 0, scroll = 0, lastPinch = null;
  const DOWN = new THREE.Vector3(-0.24, -0.44, -0.34), UP = new THREE.Vector3(-0.1, -0.11, -0.3);   // the free left hand
  root.position.copy(DOWN); root.visible = false;
  function update(dt, active, pinchY) {
    raise += ((active ? 1 : 0) - raise) * Math.min(1, dt * 7);
    root.visible = raise > 0.02;
    root.position.lerpVectors(DOWN, UP, raise);
    root.rotation.set(-0.25 + raise * 0.12, 0.35 - raise * 0.3, -0.12);
    glow.intensity = raise * 0.6;
    if (raise > 0.3) {
      if (pinchY != null && lastPinch != null) scroll += (lastPinch - pinchY) * 900;
      scroll += dt * 140;                                            // the feed never stops
      drawFeed(can, scroll); tex.needsUpdate = true;
    }
    lastPinch = pinchY ?? null;
    return raise;
  }
  return { root, update, get raise() { return raise; } };
}
