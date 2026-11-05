// Last Hand Standing: the game loop. Low-poly world, zombies from the Polyart
// pack, the FPS pistol, waves, and the hand / keyboard controls.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from '../vendor/three/addons/utils/SkeletonUtils.js';
import * as G from './gestures.js';
import { startHands, drawPreview } from './hands.js';
import { buildWorld } from './world.js';
import { createMusic, createDiscs, createPhone, TRACKS } from './extras.js';

const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------- renderer + scene
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, 1, 0.01, 220);
camera.rotation.order = 'YXZ';
scene.add(camera);

const handLight = new THREE.PointLight(0xffe2c0, 0.7, 2.5);   // keeps the gun readable at night
camera.add(handLight);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- world (see world.js)
const ARENA = 52;
let world = null, colliders = [], solids = [];

// ---------------------------------------------------------------- assets
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const loadGLB = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));

let zombieTypes = [];      // { template, clip, height, upperArms: [names], head: name }
let gun = null;            // { root, mixer, idle, reload, slide, slideRest, muzzle }
let phone = null, discs = null;
const music = createMusic(() => audio());

async function loadAssets() {
  const [zg, pg, ph] = await Promise.all([loadGLB('./assets/zombies.glb'), loadGLB('./assets/pistol.glb'), loadGLB('./assets/phone.glb')]);
  phone = createPhone(camera, ph.scene);

  // Zombies: ten characters share one take. Split it per character and trim the
  // trailing hold so each walk loops.
  zg.scene.updateMatrixWorld(true);
  const clip = zg.animations[0];
  const rigs = [];
  zg.scene.traverse((o) => { if (/^rig_CharRoot/.test(o.name)) rigs.push(o); });
  zombieTypes = rigs.map((rig) => {
    const names = new Set(); rig.traverse((o) => names.add(o.name));
    let end = 0;
    const tracks = clip.tracks.filter((t) => names.has(t.name.split('.')[0])).map((t) => {
      const n = t.getValueSize(), v = t.values, last = v.length - n;
      let k = t.times.length - 1;
      while (k > 0) { let same = true; for (let c = 0; c < n; c++) if (Math.abs(v[k * n + c] - v[last + c]) > 1e-3) { same = false; break; } if (!same) break; k--; }
      end = Math.max(end, t.times[Math.min(t.times.length - 1, k + 1)]);
      return t;
    });
    const walk = new THREE.AnimationClip('walk', -1, tracks.map((t) => t.clone()));
    walk.tracks.forEach((t) => t.trim(0, end));
    walk.resetDuration();
    // a stand-alone copy of this character, with the pack's parent transforms baked in
    const holder = new THREE.Group();
    rig.parent.matrixWorld.decompose(holder.position, holder.quaternion, holder.scale);
    holder.add(cloneSkinned(rig));
    holder.position.set(0, 0, 0);
    const wrap = new THREE.Group(); wrap.add(holder);
    const upperArms = [], legs = []; let head = null;
    holder.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
      if (/UpperArm\d/.test(o.name)) upperArms.push(o.name);
      if (/Head\d/.test(o.name) && !/Nub/.test(o.name)) head = o.name;
    });
    // centre on the feet and measure the height in the walk's first pose
    const mx = new THREE.AnimationMixer(holder); mx.clipAction(walk).play(); mx.setTime(0); wrap.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrap), c = box.getCenter(new THREE.Vector3());
    holder.position.set(-c.x, -box.min.y, -c.z);
    return { template: wrap, clip: walk, height: box.max.y - box.min.y, upperArms, head, name: rig.name };
  });

  // Pistol with arms. Centimetres; the eye sits about 20 cm above and 30 cm behind its origin.
  const root = new THREE.Group();
  pg.scene.scale.setScalar(0.01);
  pg.scene.rotation.y = Math.PI;                 // the rig faces +Z; turn it to face forward (-Z)
  pg.scene.position.set(0.14, -0.26, -0.38);     // eye behind the shoulder: gun low and to the right
  root.add(pg.scene);
  pg.scene.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; if (o.material) o.material.fog = false; } });
  const mixer = new THREE.AnimationMixer(pg.scene);
  const base = pg.animations[0];
  const idle = mixer.clipAction(base.clone()); idle.play(); idle.time = 5.85; idle.timeScale = 0;  // one-handed aim (the rig has no two-handed aim pose)
  const reload = mixer.clipAction(THREE.AnimationUtils.subclip(base, 'reload', 6, 57, 30)); reload.setLoop(THREE.LoopOnce, 1); reload.clampWhenFinished = true;
  const slide = pg.scene.getObjectByName('slide');
  const muzzle = new THREE.Object3D();
  const mb = pg.scene.getObjectByName('muzzlebreak') || slide;
  mb.add(muzzle); muzzle.position.set(0, 0, 4);
  const flash = new THREE.Mesh(new THREE.IcosahedronGeometry(0.035, 0), new THREE.MeshBasicMaterial({ color: 0xffd27a, fog: false }));
  flash.visible = false; scene.add(flash);
  const flashLight = new THREE.PointLight(0xffb45a, 0, 6); scene.add(flashLight);
  camera.add(root);
  mixer.update(0);
  gun = { root, model: pg.scene, mixer, idle, reload, slide, slideRest: 7.91,   // slide forward (the held pose has it racked)
    muzzle, flash, flashLight, kick: 0 };
}

// ---------------------------------------------------------------- audio (synthesised)
let actx = null;
function audio() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } return actx; }
function noiseBurst(dur, freq, gain, q = 0.7) {
  const a = audio(); if (!a) return;
  const n = a.createBuffer(1, a.sampleRate * dur, a.sampleRate), d = n.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.5);
  const src = a.createBufferSource(); src.buffer = n;
  const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq; f.Q.value = q;
  const g = a.createGain(); g.gain.value = gain;
  src.connect(f).connect(g).connect(a.destination); src.start();
}
const sfx = {
  shot() { noiseBurst(0.22, 2400, 0.55); const a = audio(); if (!a) return; const o = a.createOscillator(), g = a.createGain(); o.frequency.setValueAtTime(140, a.currentTime); o.frequency.exponentialRampToValueAtTime(40, a.currentTime + 0.12); g.gain.setValueAtTime(0.6, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.14); o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.15); },
  empty() { noiseBurst(0.04, 5000, 0.25, 4); },
  reload() { noiseBurst(0.05, 3500, 0.3, 3); setTimeout(() => noiseBurst(0.06, 2500, 0.35, 3), 650); setTimeout(() => noiseBurst(0.05, 4200, 0.35, 3), 1350); },
  hit() { noiseBurst(0.08, 900, 0.35, 1.5); },
  hurt() { noiseBurst(0.25, 300, 0.7, 1); },
  groan(vol = 0.2) {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), lfo = a.createOscillator(), lg = a.createGain(), f = a.createBiquadFilter(), g = a.createGain();
    o.type = 'sawtooth'; o.frequency.value = rand(70, 110); lfo.frequency.value = rand(4, 7); lg.gain.value = rand(8, 18);
    lfo.connect(lg).connect(o.frequency); f.type = 'lowpass'; f.frequency.value = 700;
    const t = a.currentTime; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.25); g.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    o.connect(f).connect(g).connect(a.destination); o.start(); lfo.start(); o.stop(t + 1.4); lfo.stop(t + 1.4);
  },
};

// ---------------------------------------------------------------- player
const player = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, vy: 0, ground: true, hp: 100, ammo: 12, mag: 12, reloading: 0, bob: 0 };
const EYE = 1.62, SPEED = 4.3, RADIUS = 0.35;

function collide(p, r) {
  for (const c of colliders) {
    const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), m = c.r + r;
    if (d < m && d > 1e-4) { p.x = c.x + dx / d * m; p.z = c.z + dz / d * m; }
  }
  const d = Math.hypot(p.x, p.z);
  if (d > ARENA) { p.x *= ARENA / d; p.z *= ARENA / d; }
}

// ---------------------------------------------------------------- zombies
const zombies = [];
const hitTargets = [];        // invisible hit boxes of living zombies
const HITMAT = new THREE.MeshBasicMaterial({ visible: false });

function spawnZombie(wave, dist, opts = {}) {
  const type = zombieTypes[(Math.random() * zombieTypes.length) | 0];
  const obj = cloneSkinned(type.template);
  const h = opts.alpha ? 2.35 : rand(1.66, 1.86), s = h / type.height;
  obj.scale.setScalar(s);
  const a = Math.random() * Math.PI * 2, r = dist ?? rand(24, 36);
  obj.position.set(player.pos.x + Math.cos(a) * r, 0, player.pos.z + Math.sin(a) * r);
  collide(obj.position, 0.4);
  obj.position.y = world.heightAt(obj.position.x, obj.position.z);
  scene.add(obj);
  const mixer = new THREE.AnimationMixer(obj);
  const walk = mixer.clipAction(type.clip); walk.play(); walk.time = Math.random() * type.clip.duration;
  const speed = Math.min(3.4, rand(1.1, 1.6) + wave * 0.12) * (Math.random() < 0.12 + wave * 0.02 ? 1.6 : 1);
  walk.timeScale = speed / 1.2;
  const head = type.head ? obj.getObjectByName(type.head) : null;
  const arms = type.upperArms.map((n) => obj.getObjectByName(n)).filter(Boolean);
  // hit boxes: a body box on the root and a head sphere on the head bone
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.32 * h / s, 0.8 * h / s, 0.24 * h / s), HITMAT); body.position.y = 0.42 * h / s; obj.add(body);
  if (opts.alpha) walk.timeScale = 0;
  const hz = { obj, mixer, walk, head, arms, speed, alpha: !!opts.alpha, hp: opts.alpha ? 24 + wave * 2 : 3 + Math.floor(wave / 3), attackT: rand(0, 0.6), lunge: 0, dead: false, deadT: 0, flash: 0, groanT: rand(2, 8), meshes: [] };
  body.userData = { z: hz, part: 'body' };
  hz.meshes.push(body);
  if (head) {
    const hs = new THREE.Mesh(new THREE.SphereGeometry(0.1 * h, 8, 6), HITMAT);
    head.updateMatrixWorld(true);
    const ws = new THREE.Vector3(); head.getWorldScale(ws); hs.scale.setScalar(1 / ws.x);
    head.add(hs); hs.position.set(0, 0, 0);
    hs.userData = { z: hz, part: 'head' }; hz.meshes.push(hs);
  }
  hitTargets.push(...hz.meshes);
  obj.traverse((o) => { if (o.isMesh && o.material && o.material.visible !== false) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(0x000000); } });
  if (opts.alpha) {
    // a purple aura and a pulsing ring at its feet
    obj.traverse((o) => { if (o.isSkinnedMesh) o.material.emissive.setRGB(0.12, 0.02, 0.18); });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9 / s, 1.25 / s, 32), new THREE.MeshBasicMaterial({ color: 0xb04cff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05 / s; obj.add(ring);
    const light = new THREE.PointLight(0xb04cff, 8, 12, 1.6); light.position.y = 2 / s; obj.add(light);
    hz.ring = ring; hz.aura = light; hz.base = 0.12;
    alpha = hz; alphaAge = 0;
    banner('AN ALPHA IS DANCING · FIND IT', 2600);
  }
  zombies.push(hz);
  if (Math.random() < 0.5) sfx.groan(0.08);
}

const tmp = new THREE.Vector3(), tq = new THREE.Quaternion(), ax = new THREE.Vector3(1, 0, 0);
function updateZombies(dt) {
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i], o = z.obj;
    if (z.dead) {
      z.deadT += dt;
      const k = Math.min(1, z.deadT / 0.55);
      o.rotation.x = -Math.PI / 2 * (k * k);           // falls backwards
      if (z.deadT > 2.5) o.position.y -= dt * 0.5;
      if (z.deadT > 4.5) { scene.remove(o); zombies.splice(i, 1); }
      continue;
    }
    const dx = player.pos.x - o.position.x, dz = player.pos.z - o.position.z, d = Math.hypot(dx, dz);
    o.rotation.y = Math.atan2(dx, dz);
    if (z.alpha) {                                     // it doesn't chase you: it dances and calls the horde
      const tt = performance.now() / 1000;
      o.rotation.y += Math.sin(tt * 4) * 0.6;
      o.position.y = world.heightAt(o.position.x, o.position.z) + Math.abs(Math.sin(tt * 6.3)) * 0.18;
      z.mixer.update(dt);
      z.arms.forEach((a, k) => { tq.setFromAxisAngle(ax, -(2.2 + Math.sin(tt * 6.3 + k * Math.PI) * 0.7)); a.quaternion.multiply(tq); });
      z.ring.scale.setScalar(1 + Math.abs(Math.sin(tt * 6.3)) * 0.25); z.aura.intensity = 6 + Math.abs(Math.sin(tt * 6.3)) * 6;
      z.attackT -= dt;
      if (d < 1.8 && z.attackT <= 0 && player.hp > 0) { z.attackT = 0.9; hurt(14 + wave); }
      if (z.flash > 0) { z.flash -= dt; const f = Math.max(0, z.flash) * 3; o.traverse((m) => { if (m.isSkinnedMesh) m.material.emissive.setRGB(0.12 + f * 0.8, 0.02, 0.18); }); }
      continue;
    }
    if (d > 1.15) {
      o.position.x += dx / d * z.speed * dt; o.position.z += dz / d * z.speed * dt;
      z.walk.paused = false;
    }
    // keep apart from each other and out of obstacles
    for (const w of zombies) {
      if (w === z || w.dead) continue;
      const ex = o.position.x - w.obj.position.x, ez = o.position.z - w.obj.position.z, e = Math.hypot(ex, ez);
      if (e < 0.7 && e > 1e-4) { o.position.x += ex / e * (0.7 - e) * 0.5; o.position.z += ez / e * (0.7 - e) * 0.5; }
    }
    collide(o.position, 0.35);
    o.position.y = world.heightAt(o.position.x, o.position.z);
    z.mixer.update(dt);
    // attack: reach forward, then swipe
    z.attackT -= dt;
    if (d < 1.4) {
      z.lunge = Math.min(1, z.lunge + dt * 5);
      if (z.attackT <= 0 && player.hp > 0) { z.attackT = 1.1; hurt(8 + wave); }
    } else z.lunge = Math.max(0, z.lunge - dt * 3);
    const swing = z.lunge * (0.9 + 0.5 * Math.sin(performance.now() / 120));
    for (const a of z.arms) { tq.setFromAxisAngle(ax, -swing * 0.9); a.quaternion.multiply(tq); }
    // hit flash
    if (z.flash > 0) { z.flash -= dt; const f = Math.max(0, z.flash) * 3; o.traverse((m) => { if (m.isSkinnedMesh) m.material.emissive.setRGB(f * 0.8, 0, 0); }); }
    z.groanT -= dt;
    if (z.groanT < 0) { z.groanT = rand(4, 10); if (d < 25) sfx.groan(0.12 * (1 - d / 25)); }
  }
}

function killZombie(z) {
  z.dead = true;
  z.mixer.stopAllAction();
  for (const m of z.meshes) { const k = hitTargets.indexOf(m); if (k >= 0) hitTargets.splice(k, 1); }
  stats.kills++;
  if (z.alpha) {
    alpha = null; alphaTimer = rand(40, 70);
    if (z.ring) z.obj.remove(z.ring); if (z.aura) z.obj.remove(z.aura);
    player.hp = Math.min(100, player.hp + 30);
    banner('ALPHA DOWN · +30 HP', 2200);
    $('alpha').hidden = true;
  }
}

// ---------------------------------------------------------------- shooting
const ray = new THREE.Raycaster();
const tracers = [];
const stats = { kills: 0, shots: 0, hits: 0 };
let aimNDC = new THREE.Vector2(0, 0);

function shoot() {
  if (state !== 'play' || player.reloading > 0) return;
  if (phone && phone.raise > 0.15) return;                // busy doom-scrolling
  if (player.ammo <= 0) { sfx.empty(); startReload(); return; }
  player.ammo--; stats.shots++;
  sfx.shot();
  gun.kick = 1;
  player.pitch = clamp(player.pitch + 0.012, -1.2, 1.2);
  ray.setFromCamera(aimNDC, camera);
  ray.far = 120;
  const hits = ray.intersectObjects([...hitTargets, ...solids], false);
  let end = ray.ray.at(60, new THREE.Vector3());
  if (hits.length) {
    const h = hits[0]; end = h.point;
    const tag = h.object.userData;
    if (tag && tag.z && !tag.z.dead) {
      const z = tag.z, head = tag.part === 'head';
      z.hp -= head ? 3 : 1; z.flash = 0.18; stats.hits++;
      sfx.hit();
      $('crosshair').classList.add('hit'); setTimeout(() => $('crosshair').classList.remove('hit'), 90);
      // knockback
      const k = head ? 0.35 : 0.2; tmp.copy(ray.ray.direction).setY(0).normalize(); z.obj.position.addScaledVector(tmp, k);
      if (z.hp <= 0) killZombie(z);
    }
  }
  // tracer from the muzzle
  const from = gun.muzzle.getWorldPosition(new THREE.Vector3());
  const geo = new THREE.BufferGeometry().setFromPoints([from, end]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.85 }));
  scene.add(line); tracers.push({ line, t: 0.07 });
  gun.flash.position.copy(from); gun.flash.visible = true; gun.flashLight.position.copy(from); gun.flashLight.intensity = 4;
  if (player.ammo === 0) setTimeout(startReload, 250);
}

function startReload() {
  if (player.reloading > 0 || player.ammo === player.mag) return;
  player.reloading = 1.7;
  gun.reload.reset(); gun.reload.play(); gun.idle.weight = 0;
  sfx.reload();
  $('reloading').hidden = false;
}

// ---------------------------------------------------------------- damage + waves
let wave = 1, toSpawn = 0, spawnT = 0, breakT = 0, state = 'menu', paused = false;
let alpha = null, alphaAge = 0, alphaTimer = 45, extraT = 3, beatT = 0;
function hurt(n) {
  player.hp = Math.max(0, player.hp - n);
  sfx.hurt();
  $('hurt').style.opacity = 1; setTimeout(() => { $('hurt').style.opacity = 0; }, 160);
  if (player.hp <= 0) gameOver();
}
function banner(text, ms = 1800) { const b = $('banner'); b.textContent = text; b.classList.add('show'); clearTimeout(banner.t); banner.t = setTimeout(() => b.classList.remove('show'), ms); }
function startWave(n) { wave = n; toSpawn = 4 + n * 3; spawnT = 1.5; banner('WAVE ' + n); }

function updateWaves(dt) {
  const alive = zombies.filter((z) => !z.dead).length;
  if (toSpawn > 0) {
    spawnT -= dt;
    if (spawnT <= 0 && alive < 14 + wave) { spawnZombie(wave); toSpawn--; spawnT = Math.max(0.35, 1.5 - wave * 0.1); }
  } else if (alive === 0) {
    if (breakT <= 0) { breakT = 4; banner('WAVE ' + wave + ' CLEARED', 2200); player.hp = Math.min(100, player.hp + 25); }
    breakT -= dt;
    if (breakT <= 0) startWave(wave + 1);
  }
  // the alpha: turns up from wave 2; while it dances, extra zombies keep coming, faster and faster
  if (!alpha && wave >= 2) { alphaTimer -= dt; if (alphaTimer <= 0) spawnZombie(wave, rand(18, 30), { alpha: true }); }
  if (alpha) {
    alphaAge += dt;
    const boost = Math.min(4, 1 + alphaAge / 12);
    extraT -= dt * boost;
    if (extraT <= 0 && alive < 22 + wave) { spawnZombie(wave); extraT = 3.2; }
    $('alpha').hidden = false; $('alpha').textContent = 'ALPHA DANCING · SPAWNS ×' + boost.toFixed(1);
    // its beat: louder as you get closer, panned toward it
    beatT -= dt;
    if (beatT <= 0) { beatT = 0.476; beat(alpha.obj.position); }
  }
  $('left').textContent = alive + toSpawn;
}
function beat(pos) {
  const a = audio(); if (!a) return;
  const dx = pos.x - player.pos.x, dz = pos.z - player.pos.z, d = Math.hypot(dx, dz);
  const ang = Math.atan2(dx, dz) - Math.atan2(-Math.sin(player.yaw), -Math.cos(player.yaw));
  const o = a.createOscillator(), g = a.createGain(), p = a.createStereoPanner ? a.createStereoPanner() : null, t = a.currentTime;
  o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
  g.gain.setValueAtTime(Math.max(0.03, 0.5 * (1 - d / 60)), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  if (p) { p.pan.value = Math.max(-1, Math.min(1, -Math.sin(ang))); o.connect(g).connect(p).connect(a.destination); } else o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + 0.25);
}

// ---------------------------------------------------------------- input
let inputMode = 'keys', gunSide = 'right', hands = null, lastFrame = -1;
const gunState = G.createGun(), moveState = G.createMove();
let gesture = { gun: null, move: null };
const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (state !== 'play') return;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'Space') { jump(); e.preventDefault(); }
  if (e.code === 'KeyP') setPaused(!paused);
  if (e.code === 'KeyC') $('cam').hidden = !$('cam').hidden;
});
addEventListener('keyup', (e) => keys.delete(e.code));
canvas.addEventListener('mousedown', () => {
  if (state !== 'play') return;
  if (inputMode === 'keys' && document.pointerLockElement !== canvas) { canvas.requestPointerLock?.(); setPaused(false); return; }
  if (inputMode === 'keys') shoot();
});
addEventListener('mousemove', (e) => {
  if (state === 'play' && inputMode === 'keys' && document.pointerLockElement === canvas) {
    player.yaw -= e.movementX * 0.0022; player.pitch = clamp(player.pitch - e.movementY * 0.0022, -1.2, 1.2);
  }
});
document.addEventListener('pointerlockchange', () => { if (state === 'play' && inputMode === 'keys' && document.pointerLockElement !== canvas) setPaused(true); });
function setPaused(p) { paused = p; if (p) banner(inputMode === 'keys' ? 'PAUSED · CLICK TO RESUME' : 'PAUSED · PRESS P', 1e9); else $('banner').classList.remove('show'); }
function jump() { if (player.ground) { player.vy = 5.2; player.ground = false; } }

function readHands(t) {
  if (!hands || hands.frame === lastFrame) return null;
  lastFrame = hands.frame;
  const { gun: gl, move: ml } = G.assignHands(hands.hands, gunSide);
  gesture = { gun: G.updateGun(gunState, gl, t), move: G.updateMove(moveState, ml, t), gl, ml };
  return gesture;
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
let frameCount = 0;
function frame() {
  frameCount++;
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  const fresh = inputMode === 'hands' ? readHands(t) : null;
  if (state === 'calib') updateCalib();
  if (state === 'play' && !paused) {
    // aim + movement input
    let moveF = 0, moveS = 0;
    if (inputMode === 'hands') {
      const g = gesture.gun, m = gesture.move;
      if (g && g.visible) {
        aimNDC.set(g.aim.x * 2 - 1, -(g.aim.y * 2 - 1));
        // aiming near the edges turns you
        const ex = g.aim.x < 0.2 ? (g.aim.x - 0.2) / 0.2 : g.aim.x > 0.8 ? (g.aim.x - 0.8) / 0.2 : 0;
        const ey = g.aim.y < 0.18 ? (g.aim.y - 0.18) / 0.18 : g.aim.y > 0.82 ? (g.aim.y - 0.82) / 0.18 : 0;
        player.yaw -= ex * 2.1 * dt; player.pitch = clamp(player.pitch - ey * 1.2 * dt, -0.7, 0.7);
        if (fresh && g.fire) shoot();
        if (fresh && g.reload) startReload();
        $('crosshair').classList.toggle('cocked', g.cocked);
      }
      if (m && m.visible) { moveF = m.forward; moveS = m.strafe; if (fresh && m.jump) jump(); }
      const ch = $('crosshair'); ch.style.left = (aimNDC.x + 1) / 2 * 100 + '%'; ch.style.top = (1 - aimNDC.y) / 2 * 100 + '%';
    } else {
      aimNDC.set(0, 0);
      moveF = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      moveS = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    }
    // phone: hold Q, or make an OK sign with the move hand
    const m = gesture.move, wantPhone = keys.has('KeyQ') || (inputMode === 'hands' && m && m.state === 'phone');
    const raise = phone ? phone.update(dt, wantPhone, inputMode === 'hands' && m ? m.pinchY : null) : 0;
    if (raise > 0.85) player.hp = Math.min(100, player.hp + 7 * dt);
    if (raise > 0.15) { moveF *= 0.4; moveS *= 0.4; }
    $('scrolling').hidden = raise < 0.5;
    // music discs
    const got = discs ? discs.update(t, player.pos) : -1;
    if (got >= 0) { music.play(got); banner('♪ ' + TRACKS[got].name, 2200); $('np').textContent = '♪ ' + TRACKS[got].name; $('discs').textContent = discs.found + '/' + TRACKS.length; }
    fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)); right.set(-fwd.z, 0, fwd.x);
    const len = Math.hypot(moveF, moveS) || 1, sp = SPEED * Math.min(1, Math.hypot(moveF, moveS));
    player.pos.addScaledVector(fwd, moveF / len * sp * dt).addScaledVector(right, moveS / len * sp * dt);
    collide(player.pos, RADIUS);
    player.vy -= 14 * dt; player.pos.y += player.vy * dt;
    const gy = world.heightAt(player.pos.x, player.pos.z);
    if (player.pos.y <= gy) { player.pos.y = gy; player.vy = 0; player.ground = true; }
    player.bob += sp * dt * 2.2;

    updateZombies(dt);
    updateWaves(dt);
    if (player.reloading > 0) {
      player.reloading -= dt;
      if (player.reloading <= 0) { player.ammo = player.mag; gun.reload.stop(); gun.idle.weight = 1; $('reloading').hidden = true; }
    }
  }
  // camera
  camera.position.set(player.pos.x, player.pos.y + EYE + Math.sin(player.bob) * 0.035, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
  // gun: point towards the crosshair, recoil, slide
  if (gun) {
    gun.mixer.update(dt);
    const tx = aimNDC.x * 0.32, ty = aimNDC.y * 0.22;
    const dip = phone ? phone.raise : 0;
    gun.root.rotation.y += (-tx - gun.root.rotation.y) * 0.25;
    gun.root.rotation.x += (ty + gun.kick * 0.18 - dip * 0.12 - gun.root.rotation.x) * 0.35;
    // with the phone out the gun stays in view, just lowered a little
    gun.root.position.set(aimNDC.x * 0.05 + dip * 0.02, aimNDC.y * 0.03 + Math.sin(player.bob * 2) * 0.006 - dip * 0.035, gun.kick * 0.035);
    if (gun.slide) gun.slide.position.z = gun.slideRest - gun.kick * 5.5;
    gun.kick = Math.max(0, gun.kick - dt * 9);
    if (gun.flash.visible) { gun.flashLight.intensity *= 0.6; if (gun.flashLight.intensity < 0.2) { gun.flash.visible = false; gun.flashLight.intensity = 0; } }
  }
  for (let i = tracers.length - 1; i >= 0; i--) { const tr = tracers[i]; tr.t -= dt; tr.line.material.opacity = Math.max(0, tr.t / 0.07); if (tr.t <= 0) { scene.remove(tr.line); tr.line.geometry.dispose(); tracers.splice(i, 1); } }
  world.update(t, dt, camera);
  // HUD
  if (state === 'play') {
    $('hp').style.width = player.hp + '%'; $('ammo').textContent = player.ammo; $('wave').textContent = wave; $('kills').textContent = stats.kills;
    if (inputMode === 'hands') drawHandsUI($('preview'));
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- hands UI
function colorFor(lm) { return lm === gesture.gl ? '#9be15d' : lm === gesture.ml ? '#f2efe9' : '#5d636b'; }
function drawHandsUI(cv) {
  drawPreview(cv, $('video'), hands ? hands.hands : [], colorFor);
  const g = gesture.gun, m = gesture.move;
  const set = (id, ok, text) => { const el = $(id); el.classList.toggle('ok', ok); el.querySelector('b').textContent = text; };
  set('chip-gun', !!(g && g.pose), !g || !g.visible ? 'not seen' : !g.pose ? 'make a finger gun' : g.cocked ? 'cocked' : 'aiming');
  set('chip-move', !!(m && m.state === 'open'), !m || !m.visible ? 'not seen' : m.state === 'fist' ? 'stopped' : m.state === 'open' ? (Math.abs(m.forward) + Math.abs(m.strafe) > 0.05 ? 'moving' : 'centred') : 'open your palm');
}
const calibDone = { gun: false, fire: false, move: false, walk: false };
function updateCalib() {
  drawPreview($('calib-cam'), $('video'), hands ? hands.hands : [], colorFor);
  const g = gesture.gun, m = gesture.move;
  if (g && g.pose) calibDone.gun = true;
  if (g && g.fire) calibDone.fire = true;
  if (m && m.state === 'open') calibDone.move = true;
  if (m && m.forward > 0.3) calibDone.walk = true;
  $('c-gun').classList.toggle('ok', calibDone.gun); $('c-fire').classList.toggle('ok', calibDone.fire);
  $('c-move').classList.toggle('ok', calibDone.move); $('c-walk').classList.toggle('ok', calibDone.walk);
}

// ---------------------------------------------------------------- screens
function show(id) { for (const s of ['menu', 'calib', 'over']) $(s).hidden = s !== id; $('hud').hidden = id !== null; }
function resetGame() {
  for (const z of zombies) scene.remove(z.obj);
  zombies.length = 0; hitTargets.length = 0;
  Object.assign(player, { hp: 100, ammo: 12, reloading: 0, vy: 0, yaw: 0, pitch: 0 }); player.pos.set(0, world.heightAt(0, 0), 0);
  Object.assign(stats, { kills: 0, shots: 0, hits: 0 });
  breakT = 0; $('reloading').hidden = true;
  alpha = null; alphaAge = 0; alphaTimer = rand(35, 60); $('alpha').hidden = true;
  if (discs) discs.reset(); music.stop(); $('discs').textContent = '0/' + TRACKS.length; $('np').textContent = '';
  if (gun) { gun.reload.stop(); gun.idle.weight = 1; }
}
function begin() {
  resetGame(); show(null); state = 'play'; paused = false;
  $('cam').hidden = inputMode !== 'hands';
  if (inputMode === 'hands') G.calibrateGun(gunState, gesture.gl);
  else canvas.requestPointerLock?.();
  startWave(1);
}
function gameOver() {
  state = 'over';
  document.exitPointerLock?.();
  $('o-wave').textContent = wave; $('o-kills').textContent = stats.kills;
  $('o-acc').textContent = stats.shots ? Math.round(stats.hits / stats.shots * 100) + '%' : '0%';
  show('over');
}
for (const side of ['left', 'right']) $('side-' + side).addEventListener('click', () => {
  gunSide = side; $('side-left').setAttribute('aria-pressed', String(side === 'left')); $('side-right').setAttribute('aria-pressed', String(side === 'right'));
  if (gun) gun.root.scale.x = side === 'left' ? -1 : 1;    // mirror the arms for a left-handed gun
});
$('play-keys').addEventListener('click', async () => { audio(); inputMode = 'keys'; if (!(await ready)) return; begin(); });
$('play-hands').addEventListener('click', async () => {
  audio(); inputMode = 'hands';
  const note = $('menu-note');
  if (!window.isSecureContext) { note.innerHTML = '<span class="err">The camera only works on https:// or localhost. Open the game over HTTPS, or play with the keyboard.</span>'; return; }
  note.textContent = 'Starting the camera and loading hand tracking…';
  try { if (!hands) hands = await startHands($('video')); }
  catch (e) {
    const blocked = e.name === 'NotAllowedError' || e.name === 'SecurityError';
    note.innerHTML = '<span class="err">' + (blocked && location.hostname.endsWith('claudeusercontent.com')
      ? 'This claude.ai preview is not allowed to use the camera. Hand controls work when the game runs on your own server over HTTPS (or on localhost). Play with the keyboard here.'
      : 'Could not start the camera (' + (e.name || e.message) + '). Allow camera access and try again, or play with the keyboard.') + '</span>';
    return;
  }
  if (!(await ready)) return;
  note.textContent = '';
  state = 'calib'; show('calib');
});
$('calib-center').addEventListener('click', () => G.calibrateGun(gunState, gesture.gl));
$('calib-go').addEventListener('click', begin);
$('again').addEventListener('click', begin);
$('to-menu').addEventListener('click', () => { state = 'menu'; resetGame(); show('menu'); });

// ---------------------------------------------------------------- boot
world = buildWorld(scene, { ARENA }); colliders = world.colliders; solids = world.solids;
discs = createDiscs(scene, world.heightAt, colliders);
const ready = loadAssets().then(() => true).catch((e) => { console.error(e); $('menu-note').innerHTML = '<span class="err">Could not load the game models (' + e.message + ').</span>'; return false; });
requestAnimationFrame(frame);
window.__game = { get frames() { return frameCount; }, renderer, player, zombies, stats, get discs() { return discs; }, get phone() { return phone; }, get alpha() { return alpha; }, keys, get state() { return state; }, spawnZombie, shoot, setAim: (x, y) => aimNDC.set(x, y), begin: () => { inputMode = 'keys'; return ready.then(begin); } };
