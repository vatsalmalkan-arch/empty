// Last Hand Standing: the game. First-person survival in a grey forest:
// waves of zombies (walkers, runners, brutes and a dancing alpha), limited
// ammo and drops, an upgrade pick after every wave, music discs to find, a
// phone to doom-scroll, keyboard and mouse or hand controls.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from '../vendor/three/addons/utils/SkeletonUtils.js';
import * as G from './gestures.js';
import { startHands, drawPreview } from './hands.js';
import { buildWorld } from './world.js';
import { createMusic, createDiscs, createPhone, TRACKS } from './extras.js';
import { audio, sfx, startWind, setVolume, musicOut, duck } from './audio.js';
import { createPost, createParticles, createDecals, createCasings, createMuzzleFlash } from './fx.js';

const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapAng = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const store = {
  get(k, d) { try { const v = localStorage.getItem('lhs-' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('lhs-' + k, JSON.stringify(v)); } catch (e) {} },
};

// ---------------------------------------------------------------- settings
const settings = Object.assign({ sens: 1, fov: 74, master: 0.8, music: 0.6, quality: 'high', gain: 2.3 }, store.get('settings', {}));

// ---------------------------------------------------------------- renderer + scene
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.01, 220);
camera.rotation.order = 'YXZ';
scene.add(camera);
camera.add(new THREE.PointLight(0xffe2c0, 0.7, 2.5));         // keeps the gun readable
const post = createPost(renderer, scene, camera);
function resize() { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

const ARENA = 52;
let world = null, colliders = [], solids = [];
let particles = null, decals = null, casings = null;
const flashSprite = createMuzzleFlash(); scene.add(flashSprite);
const flashLight = new THREE.PointLight(0xffb45a, 0, 7); scene.add(flashLight);
const alphaLight = new THREE.PointLight(0xb04cff, 0, 13, 1.6); scene.add(alphaLight);   // fixed light count: no shader recompiles

// ---------------------------------------------------------------- assets
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
async function loadGLB(url) {
  try { return await loader.loadAsync(url); }
  catch (e) {
    // hosts that can't serve .glb get the model as a JS module (base64)
    const m = await import(new URL(url.replace(/\.glb$/, '.glb.js'), document.baseURI).href);
    const bin = atob(m.default), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Promise((res, rej) => loader.parse(bytes.buffer, '', res, rej));
  }
}

let zombieTypes = [], gun = null, phone = null, discs = null;
const music = createMusic(() => audio(), musicOut);

async function loadAssets(progress) {
  let done = 0; const tick = (x) => { done++; progress(done / 3); return x; };
  const [zg, pg, ph] = await Promise.all([loadGLB('./assets/zombies.glb').then(tick), loadGLB('./assets/pistol.glb').then(tick), loadGLB('./assets/phone.glb').then(tick)]);
  phone = createPhone(camera, ph.scene);

  // Zombies: ten characters share one take. Split it per character and trim the trailing hold.
  zg.scene.updateMatrixWorld(true);
  const clip = zg.animations[0], rigs = [];
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
    walk.tracks.forEach((t) => t.trim(0, end)); walk.resetDuration();
    const holder = new THREE.Group();
    rig.parent.matrixWorld.decompose(holder.position, holder.quaternion, holder.scale);
    holder.add(cloneSkinned(rig)); holder.position.set(0, 0, 0);
    const wrap = new THREE.Group(); wrap.add(holder);
    const upperArms = []; let head = null;
    holder.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
      if (/UpperArm\d/.test(o.name)) upperArms.push(o.name);
      if (/Head\d/.test(o.name) && !/Nub/.test(o.name)) head = o.name;
    });
    const mx = new THREE.AnimationMixer(holder); mx.clipAction(walk).play(); mx.setTime(0); wrap.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrap), c = box.getCenter(new THREE.Vector3());
    holder.position.set(-c.x, -box.min.y, -c.z);
    return { template: wrap, clip: walk, height: box.max.y - box.min.y, upperArms, head };
  });

  // Pistol with arms (centimetres; the rig faces +Z, so it is turned to face forward)
  const root = new THREE.Group();
  pg.scene.scale.setScalar(0.01);
  pg.scene.rotation.y = Math.PI;
  pg.scene.position.set(0.14, -0.26, -0.38);
  root.add(pg.scene);
  pg.scene.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; if (o.material) o.material.fog = false; } });
  const mixer = new THREE.AnimationMixer(pg.scene), base = pg.animations[0];
  const idle = mixer.clipAction(base.clone()); idle.play(); idle.time = 5.85; idle.timeScale = 0;
  const reload = mixer.clipAction(THREE.AnimationUtils.subclip(base, 'reload', 6, 57, 30)); reload.setLoop(THREE.LoopOnce, 1); reload.clampWhenFinished = true;
  const slide = pg.scene.getObjectByName('slide');
  const muzzle = new THREE.Object3D(); (pg.scene.getObjectByName('muzzlebreak') || slide).add(muzzle); muzzle.position.set(0, 0, 4);
  const ejector = new THREE.Object3D(); (slide || pg.scene).add(ejector); ejector.position.set(2, 1, 4);
  camera.add(root); mixer.update(0);
  gun = { root, model: pg.scene, mixer, idle, reload, slide, slideRest: 7.91, muzzle, ejector, kick: 0, shove: 0 };
}

// ---------------------------------------------------------------- player + weapon
const player = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, vy: 0, ground: true, hp: 100, ammo: 12, reserve: 48, reloading: 0, bob: 0, stam: 100, stamWait: 0, cd: 0, shoveCd: 0, ads: 0, lastStep: 0, airTime: 0 };
const base = { maxHp: 100, speed: 4.3, sprint: 1.65, stamMax: 100, mag: 12, reload: 1.7, fireCd: 0.17, auto: false, dmg: 1, headMul: 3, lifesteal: 0, ammoMul: 1, shove: 1, pickRadius: 1.6 };
let pstat = { ...base };
const EYE = 1.62, RADIUS = 0.35;

// ---------------------------------------------------------------- upgrades
const UPGRADES = [
  { id: 'dmg', ic: '+25%', name: 'Hollow points', desc: 'Every bullet hits 25% harder.', max: 5, apply: (s) => { s.dmg *= 1.25; } },
  { id: 'mag', ic: '+4', name: 'Extended mag', desc: 'Four more rounds per magazine.', max: 4, apply: (s) => { s.mag += 4; } },
  { id: 'reload', ic: '−25%', name: 'Speed loader', desc: 'Reload a quarter faster.', max: 3, apply: (s) => { s.reload *= 0.75; } },
  { id: 'trigger', ic: 'AUTO', name: 'Hair trigger', desc: 'Faster fire rate. Hold to keep firing.', max: 3, apply: (s) => { s.fireCd *= 0.75; s.auto = true; } },
  { id: 'hp', ic: '+25', name: 'Iron lungs', desc: '+25 max health, and heal to full.', max: 4, apply: (s) => { s.maxHp += 25; player.hp = s.maxHp; } },
  { id: 'speed', ic: '+12%', name: 'Running shoes', desc: 'Move 12% faster.', max: 3, apply: (s) => { s.speed *= 1.12; } },
  { id: 'stam', ic: '+40%', name: 'Second wind', desc: 'More stamina for sprinting.', max: 3, apply: (s) => { s.stamMax *= 1.4; } },
  { id: 'pockets', ic: '+36', name: 'Deep pockets', desc: '+36 reserve ammo now, and ammo drops give 50% more.', max: 3, apply: (s) => { s.ammoMul *= 1.5; player.reserve += 36; } },
  { id: 'vamp', ic: '+3', name: 'Bloodthirst', desc: 'Heal 3 health for every kill.', max: 3, apply: (s) => { s.lifesteal += 3; } },
  { id: 'head', ic: '×1.5', name: 'Headhunter', desc: 'Headshots deal 50% more damage.', max: 3, apply: (s) => { s.headMul *= 1.5; } },
  { id: 'shove', ic: 'F+', name: 'Linebacker', desc: 'Your shove hits harder, reaches further and recovers faster.', max: 3, apply: (s) => { s.shove *= 1.4; } },
  { id: 'magnet', ic: '+1m', name: 'Scavenger', desc: 'Pick up drops from further away; more drops.', max: 2, apply: (s) => { s.pickRadius += 1.2; } },
];
let owned = {};
function rollUpgrades() {
  const pool = UPGRADES.filter((u) => (owned[u.id] || 0) < u.max);
  const out = [];
  while (out.length < 3 && pool.length) out.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  return out;
}

// ---------------------------------------------------------------- collisions
function collide(p, r) {
  for (const c of colliders) {
    const dx = p.x - c.x, dz = p.z - c.z, d = dx * dx + dz * dz, m = c.r + r;
    if (d < m * m && d > 1e-8) { const s = Math.sqrt(d); p.x = c.x + dx / s * m; p.z = c.z + dz / s * m; }
  }
  const d = Math.hypot(p.x, p.z);
  if (d > ARENA) { p.x *= ARENA / d; p.z *= ARENA / d; }
}

// ---------------------------------------------------------------- zombies
const zombies = [], hitTargets = [];
const HITMAT = new THREE.MeshBasicMaterial({ visible: false });
const KINDS = {
  walker: { h: [1.66, 1.86], speed: (w) => Math.min(2.6, rand(1.1, 1.6) + w * 0.08), hp: (w) => 3 + Math.floor(w / 3), dmg: (w) => 8 + w, pts: 100, tint: [0, 0, 0], stun: 0.14, knock: 1 },
  runner: { h: [1.6, 1.74], speed: () => rand(3.3, 4.1), hp: (w) => 2 + Math.floor(w / 4), dmg: (w) => 6 + w, pts: 150, tint: [0.16, 0.02, 0], stun: 0.22, knock: 1.3 },
  brute: { h: [2.15, 2.3], speed: () => rand(0.95, 1.15), hp: (w) => 12 + w * 1.5, dmg: (w) => 20 + w * 1.5, pts: 350, tint: [0.03, 0.035, 0.02], stun: 0.04, knock: 0.25 },
  alpha: { h: [2.35, 2.35], speed: () => 0, hp: (w) => 26 + w * 2, dmg: (w) => 14 + w, pts: 1000, tint: [0.12, 0.02, 0.18], stun: 0, knock: 0.1 },
};
function pickKind(w) {
  const r = Math.random();
  if (w >= 3 && r < Math.min(0.2, 0.05 + w * 0.015)) return 'brute';
  if (w >= 2 && r < Math.min(0.45, 0.14 + w * 0.035) + 0.2) return Math.random() < 0.5 ? 'runner' : 'walker';
  return 'walker';
}

function spawnZombie(w, dist, opts = {}) {
  const kind = opts.kind || (opts.alpha ? 'alpha' : pickKind(w)), K = KINDS[kind];
  const type = zombieTypes[(Math.random() * zombieTypes.length) | 0];
  const obj = cloneSkinned(type.template);
  const h = rand(K.h[0], K.h[1]), s = h / type.height;
  obj.scale.setScalar(s);
  // appear in the fog, preferably not right in front of you
  let x = 0, z = 0;
  for (let k = 0; k < 8; k++) {
    const a = Math.random() * Math.PI * 2, r = dist ?? rand(24, 34);
    x = player.pos.x + Math.cos(a) * r; z = player.pos.z + Math.sin(a) * r;
    const rel = Math.abs(wrapAng(Math.atan2(-(x - player.pos.x), -(z - player.pos.z)) - player.yaw));
    if (rel > 0.9 || k === 7) break;
  }
  obj.position.set(x, 0, z); collide(obj.position, 0.4);
  obj.position.y = world.heightAt(obj.position.x, obj.position.z);
  scene.add(obj);
  const mixer = new THREE.AnimationMixer(obj);
  const walk = mixer.clipAction(type.clip); walk.play(); walk.time = Math.random() * type.clip.duration;
  const speed = K.speed(w);
  walk.timeScale = kind === 'alpha' ? 0 : Math.max(0.7, speed / 1.2) * (kind === 'brute' ? 0.85 : 1);
  const head = type.head ? obj.getObjectByName(type.head) : null;
  const arms = type.upperArms.map((n) => obj.getObjectByName(n)).filter(Boolean);
  const z0 = { obj, mixer, walk, head, arms, kind, K, speed, h, alpha: kind === 'alpha', hp: K.hp(w), maxHp: K.hp(w), attackT: rand(0.3, 0.8), lunge: 0, swung: false,
    dead: false, deadT: 0, flash: 0, stun: 0, kv: new THREE.Vector3(), groanT: rand(2, 8), meshes: [], mats: [] };
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.32 * h / s, 0.8 * h / s, 0.24 * h / s), HITMAT); body.position.y = 0.42 * h / s; obj.add(body);
  body.userData = { z: z0, part: 'body' }; z0.meshes.push(body);
  if (head) {
    const hs = new THREE.Mesh(new THREE.SphereGeometry(0.1 * h, 8, 6), HITMAT);
    head.updateMatrixWorld(true); const ws = new THREE.Vector3(); head.getWorldScale(ws); hs.scale.setScalar(1 / ws.x);
    head.add(hs); hs.userData = { z: z0, part: 'head' }; z0.meshes.push(hs);
  }
  hitTargets.push(...z0.meshes);
  obj.traverse((o) => { if (o.isSkinnedMesh) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(...K.tint); z0.mats.push(o.material); } });
  if (z0.alpha) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9 / s, 1.25 / s, 32), new THREE.MeshBasicMaterial({ color: 0xb04cff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05 / s; obj.add(ring); z0.ring = ring;
    alpha = z0; alphaAge = 0;
    banner('AN ALPHA IS DANCING', 'Follow the beat. Put it down before the horde grows.', 3000);
  }
  zombies.push(z0);
  if (Math.random() < 0.4) sfx.groan(0.06, panOf(obj.position));
  return z0;
}

function panOf(p) {
  const ang = wrapAng(Math.atan2(-(p.x - player.pos.x), -(p.z - player.pos.z)) - player.yaw);
  return clamp(-Math.sin(ang), -1, 1);
}
function setEmissive(z, k) { for (const m of z.mats) m.emissive.setRGB(z.K.tint[0] + k * 0.8, z.K.tint[1], z.K.tint[2] + (z.alpha ? k * 0.2 : 0)); }

const tq = new THREE.Quaternion(), ax = new THREE.Vector3(1, 0, 0), tmp = new THREE.Vector3();
function updateZombies(dt, t) {
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i], o = z.obj;
    if (z.dead) {
      z.deadT += dt;
      const k = Math.min(1, z.deadT / 0.5);
      o.rotation.x = z.fallDir * Math.PI / 2 * (k * k);
      o.position.y = world.heightAt(o.position.x, o.position.z) + (k * 0.12 * z.h) - Math.max(0, z.deadT - 4) * 0.4;
      if (z.deadT > 6.5) { scene.remove(o); zombies.splice(i, 1); }
      continue;
    }
    const dx = player.pos.x - o.position.x, dz = player.pos.z - o.position.z, d = Math.hypot(dx, dz);
    if (z.flash > 0) { z.flash -= dt; setEmissive(z, Math.max(0, z.flash) * 3); }
    if (z.alpha) {
      o.rotation.y = Math.atan2(dx, dz) + Math.sin(t * 4) * 0.6;
      o.position.y = world.heightAt(o.position.x, o.position.z) + Math.abs(Math.sin(t * 6.3)) * 0.18;
      z.mixer.update(dt);
      z.arms.forEach((a, k) => { tq.setFromAxisAngle(ax, -(2.2 + Math.sin(t * 6.3 + k * Math.PI) * 0.7)); a.quaternion.multiply(tq); });
      z.ring.scale.setScalar(1 + Math.abs(Math.sin(t * 6.3)) * 0.25);
      alphaLight.position.set(o.position.x, o.position.y + 2.2, o.position.z); alphaLight.intensity = 6 + Math.abs(Math.sin(t * 6.3)) * 7;
      z.attackT -= dt;
      if (d < 1.9 && z.attackT <= 0 && player.hp > 0) { z.attackT = 0.9; hurt(z.K.dmg(wave), o.position); }
      continue;
    }
    o.rotation.y = Math.atan2(dx, dz);
    // knock-back and stagger
    if (z.kv.lengthSq() > 1e-4) { o.position.addScaledVector(z.kv, dt); z.kv.multiplyScalar(Math.exp(-6 * dt)); }
    z.stun -= dt;
    const moving = z.stun <= 0 && d > 1.2;
    if (moving) { o.position.x += dx / d * z.speed * dt; o.position.z += dz / d * z.speed * dt; }
    z.walk.paused = !moving && z.lunge < 0.1;
    for (const w of zombies) {
      if (w === z || w.dead) continue;
      const ex = o.position.x - w.obj.position.x, ez = o.position.z - w.obj.position.z, e2 = ex * ex + ez * ez, r = 0.35 * (z.h + w.h) / 1.75;
      if (e2 < r * r && e2 > 1e-6) { const e = Math.sqrt(e2); o.position.x += ex / e * (r - e) * 0.5; o.position.z += ez / e * (r - e) * 0.5; }
    }
    collide(o.position, 0.35);
    o.position.y = world.heightAt(o.position.x, o.position.z);
    z.mixer.update(dt);
    // attack: wind up (arms rise), then the swipe lands
    const reach = 1.35 + (z.kind === 'brute' ? 0.35 : 0);
    if (d < reach + 0.25 && z.stun <= 0) {
      z.lunge = Math.min(1, z.lunge + dt * (z.kind === 'runner' ? 5 : 3.2));
      if (z.lunge >= 1 && !z.swung) { z.swung = true; sfx.swipe(panOf(o.position)); if (d < reach + 0.3 && player.hp > 0) hurt(z.K.dmg(wave), o.position); z.attackT = z.kind === 'brute' ? 1.4 : 0.9; }
    } else z.lunge = Math.max(0, z.lunge - dt * 3);
    if (z.swung) { z.attackT -= dt; if (z.attackT <= 0) { z.swung = false; z.lunge = 0.2; } }
    const swing = z.swung ? 1.3 : z.lunge * 0.9;
    for (const a of z.arms) { tq.setFromAxisAngle(ax, -swing * 1.1); a.quaternion.multiply(tq); }
    z.groanT -= dt;
    if (z.groanT < 0) { z.groanT = rand(4, 10); if (d < 26) sfx.groan(0.13 * (1 - d / 26) * (z.kind === 'brute' ? 1.6 : 1), panOf(o.position)); }
  }
}

function killZombie(z, headshot, dir) {
  z.dead = true; z.mixer.stopAllAction(); setEmissive(z, 0);
  z.fallDir = dir && (dir.x * Math.sin(z.obj.rotation.y) + dir.z * Math.cos(z.obj.rotation.y)) > 0 ? 1 : -1;
  for (const m of z.meshes) { const k = hitTargets.indexOf(m); if (k >= 0) hitTargets.splice(k, 1); }
  stats.kills++; if (headshot) stats.heads++;
  combo.n++; combo.t = 3.2;
  const mult = comboMult();
  const pts = Math.round((z.K.pts + (headshot ? 50 : 0)) * mult);
  score += pts;
  pop((headshot ? 'HEADSHOT +' : '+') + pts, z.alpha ? 'big' : headshot ? 'head' : '');
  hitmark(true); sfx.kill();
  decals.add(z.obj.position.x, z.obj.position.y, z.obj.position.z, z.h * 0.7);
  if (pstat.lifesteal) player.hp = Math.min(pstat.maxHp, player.hp + pstat.lifesteal);
  // drops
  const lowAmmo = player.ammo + player.reserve < pstat.mag * 2, magnet = 1 + (pstat.pickRadius - base.pickRadius) * 0.2;
  const r = Math.random();
  if (z.kind === 'brute' || z.alpha) { spawnPickup('ammo', z.obj.position); if (Math.random() < 0.6) spawnPickup('med', z.obj.position, 0.8); }
  else if (r < (lowAmmo ? 0.4 : 0.17) * magnet) spawnPickup('ammo', z.obj.position);
  else if (r < (lowAmmo ? 0.4 : 0.17) * magnet + (player.hp < pstat.maxHp * 0.5 ? 0.12 : 0.05) * magnet) spawnPickup('med', z.obj.position);
  if (z.alpha) {
    alpha = null; alphaTimer = rand(45, 70); alphaLight.intensity = 0;
    if (z.ring) z.obj.remove(z.ring);
    player.hp = Math.min(pstat.maxHp, player.hp + 30);
    banner('ALPHA DOWN', '+30 health · +1000', 2400);
    $('alpha').hidden = true;
  }
}

// ---------------------------------------------------------------- pickups
const pickups = [];
const PICK = {
  ammo: { geo: new THREE.BoxGeometry(0.36, 0.22, 0.24), mat: new THREE.MeshStandardMaterial({ color: 0x6b5a2a, emissive: 0xc79a2a, emissiveIntensity: 0.55, roughness: 0.7 }), color: 0xffd060 },
  med: { geo: new THREE.BoxGeometry(0.32, 0.24, 0.32), mat: new THREE.MeshStandardMaterial({ color: 0xdedbd2, emissive: 0x6be05d, emissiveIntensity: 0.45, roughness: 0.6 }), color: 0x9be15d },
};
{ const cross = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.06), new THREE.MeshBasicMaterial({ color: 0xc8352b })); PICK.med.extra = cross; }
function spawnPickup(type, at, off = 0) {
  const P = PICK[type], m = new THREE.Mesh(P.geo, P.mat); m.castShadow = true;
  if (P.extra) { const a = P.extra.clone(); a.position.y = 0.125; m.add(a); const b = a.clone(); b.rotation.y = Math.PI / 2; m.add(b); }
  const p = { type, mesh: m, x: at.x + rand(-0.6, 0.6) + off, z: at.z + rand(-0.6, 0.6), life: 30, sp: 0 };
  p.y = world.heightAt(p.x, p.z);
  m.position.set(p.x, p.y + 0.3, p.z); scene.add(m); pickups.push(p);
}
function updatePickups(dt, t) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.life -= dt;
    p.mesh.rotation.y = t * 1.8; p.mesh.position.y = p.y + 0.35 + Math.sin(t * 3 + p.x) * 0.08;
    p.mesh.visible = p.life > 5 || Math.sin(t * 20) > 0;
    p.sp -= dt; if (p.sp <= 0) { p.sp = 0.35; particles.sparkle(p.mesh.position, PICK[p.type].color, 2); }
    const d = Math.hypot(player.pos.x - p.x, player.pos.z - p.z);
    let take = d < pstat.pickRadius;
    if (take) {
      if (p.type === 'med' && player.hp >= pstat.maxHp) take = false;
      else if (p.type === 'ammo') { const n = Math.round(18 * pstat.ammoMul); player.reserve += n; pop('+' + n + ' AMMO', ''); sfx.pickup(); }
      else { player.hp = Math.min(pstat.maxHp, player.hp + 35); pop('+35 HEALTH', ''); sfx.heal(); }
    }
    if (take || p.life <= 0) { scene.remove(p.mesh); pickups.splice(i, 1); if (take) particles.sparkle(p.mesh.position, PICK[p.type].color, 22); }
  }
}

// ---------------------------------------------------------------- shooting
const ray = new THREE.Raycaster();
const stats = { kills: 0, shots: 0, hits: 0, heads: 0, time: 0 };
const combo = { n: 0, t: 0 };
const comboMult = () => Math.min(5, 1 + Math.floor(combo.n / 4));
let score = 0, aimNDC = new THREE.Vector2(0, 0), spread = 0, shake = 0, firing = false;
const tracers = [];

function canShoot() { return state === 'play' && !paused && player.reloading <= 0 && !(phone && phone.raise > 0.15) && player.cd <= 0 && gun.shove <= 0; }
function shoot() {
  if (!canShoot()) return;
  if (player.ammo <= 0) { sfx.empty(); player.cd = 0.25; if (player.reserve > 0) startReload(); else hint('NO AMMO · FIND A DROP OR SHOVE (F)', 1800); return; }
  player.ammo--; stats.shots++; player.cd = pstat.fireCd;
  sfx.shot(); gun.kick = 1; shake = Math.max(shake, 0.08);
  player.pitch = clamp(player.pitch + rand(0.008, 0.014) * (1 - player.ads * 0.5), -1.25, 1.25); player.yaw += rand(-0.004, 0.004);
  const sp = spread;
  const aim = new THREE.Vector2(aimNDC.x + rand(-sp, sp), aimNDC.y + rand(-sp, sp) * camera.aspect);
  ray.setFromCamera(aim, camera); ray.far = 140;
  const hits = ray.intersectObjects([...hitTargets, ...solids], false);
  let end = ray.ray.at(70, new THREE.Vector3());
  if (hits.length) {
    const h = hits[0]; end = h.point;
    const tag = h.object.userData;
    if (tag && tag.z && !tag.z.dead) {
      const z = tag.z, head = tag.part === 'head', dmg = pstat.dmg * (head ? pstat.headMul : 1);
      z.hp -= dmg; z.flash = 0.16; stats.hits++;
      z.stun = Math.max(z.stun, z.K.stun * (head ? 1.6 : 1));
      tmp.copy(ray.ray.direction).setY(0).normalize(); z.kv.addScaledVector(tmp, (head ? 3 : 1.8) * z.K.knock);
      particles.blood(h.point, ray.ray.direction, head ? 1.6 : 1);
      sfx.hit(head);
      if (z.hp <= 0) killZombie(z, head, ray.ray.direction); else hitmark(false);
    } else particles.dust(h.point, tmp.copy(ray.ray.direction).negate());
  }
  const from = gun.muzzle.getWorldPosition(new THREE.Vector3());
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, end]), new THREE.LineBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.9, toneMapped: false }));
  scene.add(line); tracers.push({ line, t: 0.06 });
  flashSprite.position.copy(from); flashSprite.scale.setScalar(rand(0.16, 0.24)); flashSprite.material.rotation = rand(0, 6.28); flashSprite.visible = true;
  flashLight.position.copy(from); flashLight.intensity = 5;
  particles.smoke(from, 2);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  casings.eject(gun.ejector.getWorldPosition(new THREE.Vector3()), right, up);
  if (player.ammo === 0 && player.reserve > 0) setTimeout(startReload, 220);
}

function startReload() {
  if (player.reloading > 0 || player.ammo >= pstat.mag || player.reserve <= 0 || state !== 'play') return;
  player.reloading = pstat.reload;
  gun.reload.reset(); gun.reload.timeScale = 1.7 / pstat.reload; gun.reload.play(); gun.idle.weight = 0;
  sfx.reload(pstat.reload);
  hint('RELOADING', pstat.reload * 1000);
}
function finishReload() {
  const need = pstat.mag - player.ammo, n = Math.min(need, player.reserve);
  player.ammo += n; player.reserve -= n;
  gun.reload.stop(); gun.idle.weight = 1;
}

function shoveAttack() {
  if (state !== 'play' || paused || player.shoveCd > 0 || player.reloading > 0) return;
  player.shoveCd = 1.4 / Math.sqrt(pstat.shove); gun.shove = 0.35; sfx.shove(); shake = Math.max(shake, 0.12);
  const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)), range = 2.2 + (pstat.shove - 1) * 1.2;
  let hit = 0;
  for (const z of zombies) {
    if (z.dead || z.alpha) continue;
    tmp.set(z.obj.position.x - player.pos.x, 0, z.obj.position.z - player.pos.z);
    const d = tmp.length(); if (d > range) continue;
    tmp.divideScalar(d || 1); if (tmp.dot(f) < 0.25) continue;
    z.kv.addScaledVector(tmp, 6 * pstat.shove * z.K.knock); z.stun = Math.max(z.stun, 0.9 * (z.kind === 'brute' ? 0.4 : 1)); z.lunge = 0; z.swung = false; z.flash = 0.1;
    z.hp -= 0.5 * pstat.shove; hit++;
    if (z.hp <= 0) killZombie(z, false, tmp);
  }
  if (hit) hitmark(false);
}

// ---------------------------------------------------------------- damage, waves, the alpha
let wave = 1, toSpawn = 0, spawnT = 0, breakT = 0, state = 'loading', paused = false;
let alpha = null, alphaAge = 0, alphaTimer = 45, extraT = 3, beatT = 0, heartT = 0, safetyT = 15, waveCleared = false;
function hurt(n, from) {
  if (state !== 'play') return;
  player.hp = Math.max(0, player.hp - n);
  sfx.hurt(); post.hurt(0.8); shake = Math.max(shake, 0.35);
  if (from) dmgArc(from);
  combo.n = Math.max(0, combo.n - 2);
  if (player.hp <= 0) gameOver();
}
function startWave(n) {
  wave = n; toSpawn = 5 + n * 3; spawnT = 1.2; waveCleared = false;
  banner('WAVE ' + n, n === 1 ? 'They are coming out of the fog' : n % 5 === 0 ? 'Brutes are on the move' : '', 2200); sfx.wave();
}
function updateWaves(dt) {
  let alive = 0; for (const z of zombies) if (!z.dead) alive++;
  if (toSpawn > 0) {
    spawnT -= dt;
    if (spawnT <= 0 && alive < 12 + wave * 1.5) { spawnZombie(wave); toSpawn--; spawnT = Math.max(0.3, 1.4 - wave * 0.09); }
  } else if (alive === (alpha ? 1 : 0) && !alpha && !waveCleared) {
    waveCleared = true;
    const bonus = 500 * wave; score += bonus; player.reserve += 12;
    sfx.cleared(); openUpgrades(bonus);
  }
  if (breakT > 0) { breakT -= dt; if (breakT <= 0) startWave(wave + 1); }
  // the alpha: from wave 2; while it dances, extra zombies keep coming, faster and faster
  if (!alpha && wave >= 2 && !waveCleared) { alphaTimer -= dt; if (alphaTimer <= 0) spawnZombie(wave, rand(18, 30), { alpha: true }); }
  if (alpha) {
    alphaAge += dt;
    const boost = Math.min(4, 1 + alphaAge / 12);
    extraT -= dt * boost;
    if (extraT <= 0 && alive < 22 + wave) { spawnZombie(wave); extraT = 3.2; }
    $('alpha').hidden = false; $('alpha').textContent = 'ALPHA DANCING · SPAWNS ×' + boost.toFixed(1);
    beatT -= dt;
    if (beatT <= 0) { beatT = 0.476; const d = alpha.obj.position.distanceTo(player.pos); sfx.beat(Math.max(0.04, 0.55 * (1 - d / 60)), panOf(alpha.obj.position)); }
  }
  // never leave the player with nothing to shoot with
  if (player.ammo + player.reserve === 0 && !pickups.some((p) => p.type === 'ammo')) {
    safetyT -= dt;
    if (safetyT <= 0) { safetyT = 15; const a = rand(0, 6.28); spawnPickup('ammo', tmp.set(player.pos.x + Math.cos(a) * 7, 0, player.pos.z + Math.sin(a) * 7)); hint('AN AMMO BOX FELL NEARBY', 2000); }
  } else safetyT = 8;
  $('left').textContent = alive + toSpawn;
}

// ---------------------------------------------------------------- HUD helpers
function banner(text, sub = '', ms = 1800) {
  const b = $('banner'); b.textContent = text; if (sub) { const s = document.createElement('small'); s.textContent = sub; b.appendChild(s); }
  b.classList.add('show'); clearTimeout(banner.t); banner.t = setTimeout(() => b.classList.remove('show'), ms);
}
function hint(text, ms = 1500) { const h = $('hint'); h.textContent = text; h.hidden = false; clearTimeout(hint.t); hint.t = setTimeout(() => { h.hidden = true; }, ms); }
function pop(text, cls) { const e = document.createElement('div'); e.className = 'pop ' + cls; e.textContent = text; e.style.marginTop = ($('pops').childElementCount * -18) + 'px'; $('pops').appendChild(e); setTimeout(() => e.remove(), 900); }
function hitmark(kill) { const m = $('hitmark'); m.classList.toggle('kill', kill); m.classList.add('show'); clearTimeout(hitmark.t); hitmark.t = setTimeout(() => m.classList.remove('show'), kill ? 220 : 110); }
function dmgArc(from) {
  const ang = wrapAng(Math.atan2(-(from.x - player.pos.x), -(from.z - player.pos.z)) - player.yaw);
  const e = document.createElement('div'); e.className = 'dmg-arc'; e.style.transform = `rotate(${-ang}rad)`;
  $('dmg').appendChild(e); setTimeout(() => { e.style.opacity = 0; }, 350); setTimeout(() => e.remove(), 1000);
}
const compassEl = $('compass');
function updateCompass() {
  const W = compassEl.clientWidth; if (!W) return;
  const items = [];
  const place = (heading, cls, txt, color) => {
    const rel = wrapAng(heading - player.yaw); if (Math.abs(rel) > Math.PI / 2) return;
    items.push(`<span class="${cls}" style="left:${(0.5 - rel / Math.PI) * W}px${color ? ';color:' + color : ''}">${txt || ''}</span>`);
  };
  [['N', 0], ['E', -Math.PI / 2], ['S', Math.PI], ['W', Math.PI / 2]].forEach(([n, h]) => place(h, '', n));
  for (let k = 0; k < 24; k++) if (k % 6) place(k / 24 * Math.PI * 2, 'tick');
  if (discs) for (const d of discs.discs) if (!d.taken) place(Math.atan2(-(d.x - player.pos.x), -(d.z - player.pos.z)), 'mark', '', TRACKS[d.i].color);
  if (alpha) place(Math.atan2(-(alpha.obj.position.x - player.pos.x), -(alpha.obj.position.z - player.pos.z)), 'mark alpha', '', '#c58bff');
  compassEl.innerHTML = items.join('');
}
function renderPerks() { $('perks').innerHTML = Object.entries(owned).map(([id, n]) => `<span>${UPGRADES.find((u) => u.id === id).name.toUpperCase()}${n > 1 ? ' ' + n : ''}</span>`).join(''); }

// ---------------------------------------------------------------- upgrade screen
let offer = [];
function openUpgrades(bonus) {
  offer = rollUpgrades();
  if (!offer.length) { breakT = 3; return; }
  state = 'upgrade'; document.exitPointerLock?.(); duck(true);
  $('upg-title').textContent = 'Wave ' + wave + ' cleared · +' + bonus;
  $('upg-sub').textContent = inputMode === 'hands' ? 'Aim at one and fire to pick it' : 'Pick one · click, or press 1, 2 or 3';
  $('upgs').innerHTML = offer.map((u, i) => `<button class="upg" data-i="${i}"><span class="k">${i + 1}</span><span class="ic">${u.ic}</span><h3>${u.name}</h3><p>${u.desc}</p><span class="lv">Level ${(owned[u.id] || 0) + 1} / ${u.max}</span></button>`).join('');
  $('upgrades').hidden = false;
}
function chooseUpgrade(i) {
  const u = offer[i]; if (!u || state !== 'upgrade') return;
  owned[u.id] = (owned[u.id] || 0) + 1; u.apply(pstat);
  if (u.id === 'mag') player.ammo = Math.min(pstat.mag, player.ammo + 4);
  sfx.upgrade(); renderPerks();
  $('upgrades').hidden = true; state = 'play'; duck(false); breakT = 3.5;
  banner(u.name.toUpperCase(), 'Next wave in a few seconds', 2000);
  if (inputMode === 'keys') canvas.requestPointerLock?.();
}
$('upgs').addEventListener('click', (e) => { const b = e.target.closest('.upg'); if (b) chooseUpgrade(+b.dataset.i); });

// ---------------------------------------------------------------- input
let inputMode = 'keys', gunSide = 'right', hands = null, lastFrame = -1, mouseDX = 0, mouseDY = 0, rmb = false;
const gunState = G.createGun({ gain: settings.gain }), moveState = G.createMove();
let gesture = { gun: null, move: null };
const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (state === 'upgrade' && /^Digit[123]$/.test(e.code)) chooseUpgrade(+e.code.slice(5) - 1);
  if (state !== 'play') return;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'KeyF' || e.code === 'KeyV') shoveAttack();
  if (e.code === 'Space') { jump(); e.preventDefault(); }
  if (e.code === 'KeyP' || (e.code === 'Escape' && inputMode === 'hands')) setPaused(!paused);
  if (e.code === 'KeyC') $('cam').hidden = !$('cam').hidden;
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (state !== 'play' || inputMode !== 'keys') return;
  if (document.pointerLockElement !== canvas) { canvas.requestPointerLock?.(); return; }
  if (e.button === 0) { firing = true; shoot(); }
  if (e.button === 2) rmb = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; if (e.button === 2) rmb = false; });
addEventListener('mousemove', (e) => {
  if (state === 'play' && !paused && inputMode === 'keys' && document.pointerLockElement === canvas) {
    const s = 0.0022 * settings.sens * (1 - player.ads * 0.35);
    player.yaw -= e.movementX * s; player.pitch = clamp(player.pitch - e.movementY * s, -1.25, 1.25);
    mouseDX += e.movementX; mouseDY += e.movementY;
  }
});
document.addEventListener('pointerlockchange', () => { if (state === 'play' && inputMode === 'keys' && document.pointerLockElement !== canvas && !paused) setPaused(true); });
function setPaused(p) {
  paused = p; firing = false; rmb = false;
  $('pause').hidden = !p; $('settings').hidden = true;
  duck(p);
  if (!p && inputMode === 'keys') canvas.requestPointerLock?.();
}
function jump() { if (player.ground && !(phone && phone.raise > 0.5)) { player.vy = 5.2; player.ground = false; } }
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
let frameCount = 0, hudT = 0;
function frame() {
  frameCount++;
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  const fresh = inputMode === 'hands' ? readHands(t) : null;
  if (state === 'calib') updateCalib();
  if (state === 'upgrade' && inputMode === 'hands' && gesture.gun && gesture.gun.visible) {
    const g = gesture.gun, x = g.aim.x * innerWidth, y = g.aim.y * innerHeight;
    const ch = $('crosshair'); ch.style.left = x + 'px'; ch.style.top = y + 'px';
    const el = document.elementFromPoint(x, y)?.closest('.upg');
    document.querySelectorAll('.upg').forEach((b) => b.classList.toggle('aim', b === el));
    if (fresh && g.fire && el) chooseUpgrade(+el.dataset.i);
  }
  const live = state === 'play' && !paused;
  if (live) {
    stats.time += dt;
    let moveF = 0, moveS = 0, sprinting = false;
    if (inputMode === 'hands') {
      const g = gesture.gun, m = gesture.move;
      if (g && g.visible) {
        aimNDC.set(g.aim.x * 2 - 1, -(g.aim.y * 2 - 1));
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
      sprinting = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && moveF > 0 && player.stam > 1 && !rmb;
      if (firing && pstat.auto) shoot();
    }
    // phone: hold Q, or an OK sign with the move hand
    const m = gesture.move, wantPhone = keys.has('KeyQ') || (inputMode === 'hands' && m && m.state === 'phone');
    const raise = phone.update(dt, wantPhone, inputMode === 'hands' && m ? m.pinchY : null);
    if (raise > 0.85) player.hp = Math.min(pstat.maxHp, player.hp + 7 * dt);
    if (raise > 0.15) { moveF *= 0.4; moveS *= 0.4; sprinting = false; }
    if (raise > 0.5 && !hint.phone) { hint('DOOM-SCROLLING · HEALING · CAN\'T SHOOT', 1200); hint.phone = true; } else if (raise < 0.2) hint.phone = false;
    // aim down sights
    player.ads += ((rmb && raise < 0.2 && player.reloading <= 0 ? 1 : 0) - player.ads) * Math.min(1, dt * 12);
    // stamina
    if (sprinting) { player.stam = Math.max(0, player.stam - 24 * dt); player.stamWait = 0.9; }
    else { player.stamWait -= dt; if (player.stamWait <= 0) player.stam = Math.min(pstat.stamMax, player.stam + 16 * dt); }
    // music discs
    const got = discs.update(t, player.pos);
    if (got >= 0) { music.play(got); score += 250; banner('♪ ' + TRACKS[got].name, 'Record ' + discs.found + ' of ' + TRACKS.length + ' · +250', 2400); $('np').textContent = '♪ ' + TRACKS[got].name; $('discs').textContent = discs.found + '/' + TRACKS.length; particles.sparkle(player.pos.clone().setY(player.pos.y + 1.2), TRACKS[got].color, 40); }
    // movement
    fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)); right.set(-fwd.z, 0, fwd.x);
    const mag = Math.min(1, Math.hypot(moveF, moveS)), len = Math.hypot(moveF, moveS) || 1;
    const sp = pstat.speed * mag * (sprinting ? pstat.sprint : 1) * (1 - player.ads * 0.4);
    player.pos.addScaledVector(fwd, moveF / len * sp * dt).addScaledVector(right, moveS / len * sp * dt);
    collide(player.pos, RADIUS);
    player.vy -= 14 * dt; player.pos.y += player.vy * dt;
    const gy = world.heightAt(player.pos.x, player.pos.z);
    if (player.pos.y <= gy) { if (!player.ground && player.airTime > 0.25) { sfx.land(); shake = Math.max(shake, 0.06); } player.pos.y = gy; player.vy = 0; player.ground = true; player.airTime = 0; }
    else { player.ground = false; player.airTime += dt; }
    if (player.ground && sp > 0.5) {
      player.bob += sp * dt * 2.1;
      if (Math.floor(player.bob / Math.PI) !== player.lastStep) { player.lastStep = Math.floor(player.bob / Math.PI); sfx.step(sprinting); }
    }
    spread = (inputMode === 'keys' ? 0.006 + mag * 0.02 + (sprinting ? 0.05 : 0) + (player.ground ? 0 : 0.04) : 0.004) * (1 - player.ads * 0.8);
    player.cd -= dt; player.shoveCd -= dt;
    combo.t -= dt; if (combo.t <= 0) combo.n = 0;
    updateZombies(dt, t);
    updatePickups(dt, t);
    updateWaves(dt);
    if (player.reloading > 0) { player.reloading -= dt; if (player.reloading <= 0) finishReload(); }
    if (player.hp < 30) { heartT -= dt; if (heartT <= 0) { heartT = 0.6 + player.hp / 60; sfx.heartbeat(); } }
  }
  // camera
  shake = Math.max(0, shake - dt * 1.8);
  const sx = (Math.random() - 0.5) * shake * 0.08, sy = (Math.random() - 0.5) * shake * 0.08;
  camera.position.set(player.pos.x, player.pos.y + EYE + Math.sin(player.bob) * 0.035 * (1 - player.ads * 0.7), player.pos.z);
  camera.rotation.set(player.pitch + sy, player.yaw + sx, 0);
  const fov = settings.fov * (1 - player.ads * 0.22);
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  // gun: aim, sway, recoil, ADS, shove, slide
  if (gun) {
    gun.mixer.update(dt);
    const dip = phone ? phone.raise : 0, ads = player.ads;
    const tx = aimNDC.x * 0.32 + mouseDX * 0.0009, ty = aimNDC.y * 0.22 - mouseDY * 0.0009;
    mouseDX *= 0.8; mouseDY *= 0.8;
    gun.shove = Math.max(0, gun.shove - dt);
    const sh = gun.shove > 0 ? Math.sin((1 - gun.shove / 0.35) * Math.PI) : 0;
    gun.root.rotation.y += (-tx - gun.root.rotation.y) * 0.25;
    gun.root.rotation.x += (ty + gun.kick * 0.18 - dip * 0.12 - sh * 0.4 - gun.root.rotation.x) * 0.35;
    gun.root.rotation.z = -sh * 0.5;
    gun.root.position.set(aimNDC.x * 0.05 + dip * 0.02 - ads * 0.135 - sh * 0.05, aimNDC.y * 0.03 + Math.sin(player.bob * 2) * 0.006 * (1 - ads) - dip * 0.035 + ads * 0.075, gun.kick * 0.035 - sh * 0.15 + ads * 0.04);
    if (gun.slide) gun.slide.position.z = gun.slideRest - gun.kick * 5.5;
    gun.kick = Math.max(0, gun.kick - dt * 9);
    if (flashSprite.visible) { flashLight.intensity *= 0.55; if (flashLight.intensity < 0.3) { flashSprite.visible = false; flashLight.intensity = 0; } }
  }
  for (let i = tracers.length - 1; i >= 0; i--) { const tr = tracers[i]; tr.t -= dt; tr.line.material.opacity = Math.max(0, tr.t / 0.06); if (tr.t <= 0) { scene.remove(tr.line); tr.line.geometry.dispose(); tr.line.material.dispose(); tracers.splice(i, 1); } }
  if (world) world.update(t, dt, camera);
  if (particles && live) { particles.update(dt); casings.update(dt, world.heightAt); }
  // HUD
  if (state === 'play' || state === 'upgrade') {
    hudT -= dt;
    $('hp').style.width = (player.hp / pstat.maxHp * 100) + '%';
    $('stam').style.width = (player.stam / pstat.stamMax * 100) + '%';
    $('ammo').textContent = player.ammo; $('reserve').textContent = '/ ' + player.reserve;
    $('ammo-box').classList.toggle('low', player.ammo <= Math.ceil(pstat.mag / 4));
    $('wave').textContent = wave; $('score').textContent = score.toLocaleString('en-US');
    const cm = comboMult(); $('combo').textContent = '×' + cm + ' COMBO'; $('combo').classList.toggle('on', cm > 1);
    const ch = $('crosshair'); ch.style.setProperty('--gap', (5 + spread * 700) + 'px'); ch.classList.toggle('blocked', !!(phone && phone.raise > 0.15) || player.reloading > 0);
    if (inputMode === 'keys') { ch.style.left = '50%'; ch.style.top = '50%'; }
    if (hudT <= 0) { hudT = 0.05; updateCompass(); }
    if (inputMode === 'hands') drawHandsUI($('preview'));
  }
  if (world) post.render(t, dt, state === 'play' ? clamp((35 - player.hp) / 35, 0, 1) : 0);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- hands UI
function colorFor(lm) { return lm === gesture.gl ? '#9be15d' : lm === gesture.ml ? '#f2efe9' : '#5d636b'; }
function drawHandsUI(cv) {
  drawPreview(cv, $('video'), hands ? hands.hands : [], colorFor);
  const g = gesture.gun, m = gesture.move;
  const set = (id, ok, text) => { const el = $(id); el.classList.toggle('ok', ok); el.querySelector('b').textContent = text; };
  set('chip-gun', !!(g && g.pose), !g || !g.visible ? 'not seen' : !g.pose ? 'make a finger gun' : g.cocked ? 'cocked' : 'aiming');
  set('chip-move', !!(m && (m.state === 'open' || m.state === 'phone')), !m || !m.visible ? 'not seen' : m.state === 'fist' ? 'stopped' : m.state === 'phone' ? 'phone' : m.state === 'open' ? (Math.abs(m.forward) + Math.abs(m.strafe) > 0.05 ? 'moving' : 'centred') : 'open your palm');
}
const calibDone = { gun: false, fire: false, move: false, walk: false };
function updateCalib() {
  drawPreview($('calib-cam'), $('video'), hands ? hands.hands : [], colorFor);
  const g = gesture.gun, m = gesture.move;
  if (g && g.pose) calibDone.gun = true;
  if (g && g.fire) calibDone.fire = true;
  if (m && m.state === 'open') calibDone.move = true;
  if (m && m.forward > 0.3) calibDone.walk = true;
  for (const k of ['gun', 'fire', 'move', 'walk']) $('c-' + k).classList.toggle('ok', calibDone[k]);
}

// ---------------------------------------------------------------- screens
const SCREENS = ['loading', 'menu', 'calib', 'over', 'upgrades', 'pause', 'settings'];
function show(id) { for (const s of SCREENS) $(s).hidden = s !== id; $('hud').hidden = id !== null; }
function renderBest() {
  const b = store.get('best', { score: 0, wave: 0, kills: 0 });
  $('best').innerHTML = b.score ? `<div><span class="label">Best score</span><b>${b.score.toLocaleString('en-US')}</b></div><div><span class="label">Best wave</span><b>${b.wave}</b></div><div><span class="label">Most kills</span><b>${b.kills}</b></div>` : '';
}
function resetGame() {
  for (const z of zombies) scene.remove(z.obj);
  for (const p of pickups) scene.remove(p.mesh);
  zombies.length = 0; hitTargets.length = 0; pickups.length = 0;
  pstat = { ...base }; owned = {}; renderPerks();
  Object.assign(player, { hp: 100, ammo: 12, reserve: 48, reloading: 0, vy: 0, yaw: 0, pitch: 0, stam: 100, cd: 0, shoveCd: 0, ads: 0 });
  player.pos.set(0, world.heightAt(0, 0), 0);
  Object.assign(stats, { kills: 0, shots: 0, hits: 0, heads: 0, time: 0 });
  score = 0; combo.n = 0; breakT = 0; waveCleared = false;
  alpha = null; alphaAge = 0; alphaTimer = rand(35, 55); alphaLight.intensity = 0; $('alpha').hidden = true;
  discs.reset(); decals.clear(); music.stop(); $('discs').textContent = '0/' + TRACKS.length; $('np').textContent = '';
  if (gun) { gun.reload.stop(); gun.idle.weight = 1; }
}
function begin() {
  resetGame(); show(null); state = 'play'; paused = false; startWind();
  $('cam').hidden = inputMode !== 'hands';
  if (inputMode === 'hands') G.calibrateGun(gunState, gesture.gl); else canvas.requestPointerLock?.();
  startWave(1);
}
function gameOver() {
  state = 'over'; firing = false; document.exitPointerLock?.(); duck(false);
  const best = store.get('best', { score: 0, wave: 0, kills: 0 }), isBest = score > best.score;
  store.set('best', { score: Math.max(best.score, score), wave: Math.max(best.wave, wave), kills: Math.max(best.kills, stats.kills) });
  $('newbest').hidden = !isBest;
  $('o-score').textContent = score.toLocaleString('en-US'); $('o-wave').textContent = wave; $('o-kills').textContent = stats.kills; $('o-heads').textContent = stats.heads;
  $('o-time').textContent = Math.floor(stats.time / 60) + ':' + String(Math.floor(stats.time % 60)).padStart(2, '0');
  $('o-acc').textContent = stats.shots ? Math.round(stats.hits / stats.shots * 100) + '%' : '0%';
  setTimeout(() => show('over'), 700);
}

// settings
let settingsBack = 'menu';
function openSettings(from) {
  settingsBack = from;
  const set = (id, v, fmt) => { $('s-' + id).value = v; $('o-' + id).textContent = fmt(v); };
  set('sens', settings.sens, (v) => (+v).toFixed(2)); set('fov', settings.fov, (v) => v + '°');
  set('master', settings.master, (v) => Math.round(v * 100) + '%'); set('music', settings.music, (v) => Math.round(v * 100) + '%');
  set('gain', settings.gain, (v) => (+v).toFixed(1));
  document.querySelectorAll('[data-q]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === settings.quality)));
  $('settings').hidden = false; $(from).hidden = true;
}
for (const id of ['sens', 'fov', 'master', 'music', 'gain']) $('s-' + id).addEventListener('input', (e) => {
  const v = +e.target.value; settings[id] = v; store.set('settings', settings);
  $('o-' + id).textContent = id === 'fov' ? v + '°' : id === 'master' || id === 'music' ? Math.round(v * 100) + '%' : v.toFixed(id === 'gain' ? 1 : 2);
  if (id === 'master' || id === 'music') setVolume(id, v);
  if (id === 'gain') gunState.gain = v;
});
document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
  settings.quality = b.dataset.q; store.set('settings', settings); post.setQuality(settings.quality);
  document.querySelectorAll('[data-q]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
$('settings-done').addEventListener('click', () => { $('settings').hidden = true; $(settingsBack).hidden = false; });
$('open-settings').addEventListener('click', () => openSettings('menu'));
$('pause-settings').addEventListener('click', () => openSettings('pause'));
$('resume').addEventListener('click', () => setPaused(false));
$('quit').addEventListener('click', () => { paused = false; state = 'menu'; resetGame(); renderBest(); show('menu'); duck(false); });

for (const side of ['left', 'right']) $('side-' + side).addEventListener('click', () => {
  gunSide = side; $('side-left').setAttribute('aria-pressed', String(side === 'left')); $('side-right').setAttribute('aria-pressed', String(side === 'right'));
  if (gun) gun.root.scale.x = side === 'left' ? -1 : 1;
});
$('play-keys').addEventListener('click', () => { audio(); setVolume('master', settings.master); setVolume('music', settings.music); inputMode = 'keys'; begin(); });
$('play-hands').addEventListener('click', async () => {
  audio(); setVolume('master', settings.master); setVolume('music', settings.music); inputMode = 'hands';
  const note = $('menu-note');
  if (!window.isSecureContext) { note.innerHTML = '<span class="err">The camera only works on https:// or localhost. Open the game over HTTPS, or play with the keyboard.</span>'; return; }
  note.textContent = 'Starting the camera and loading hand tracking…';
  try { if (!hands) hands = await startHands($('video')); }
  catch (e) {
    const blocked = e.name === 'NotAllowedError' || e.name === 'SecurityError';
    note.innerHTML = '<span class="err">' + (blocked && location.hostname.endsWith('claudeusercontent.com')
      ? 'This claude.ai preview is not allowed to use the camera. Hand controls work when the game runs on your own server over HTTPS (or on localhost). Use Play here for keyboard and mouse.'
      : 'Could not start the camera (' + (e.name || e.message) + '). Allow camera access and try again, or play with the keyboard.') + '</span>';
    return;
  }
  note.textContent = '';
  state = 'calib'; show('calib');
});
$('calib-center').addEventListener('click', () => G.calibrateGun(gunState, gesture.gl));
$('calib-go').addEventListener('click', begin);
$('again').addEventListener('click', () => { inputMode === 'hands' ? begin() : (audio(), begin()); });
$('to-menu').addEventListener('click', () => { state = 'menu'; resetGame(); renderBest(); show('menu'); });

// ---------------------------------------------------------------- boot
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
async function boot() {
  const bar = $('load-bar'), note = $('load-note');
  bar.style.width = '8%'; await nextFrame();
  world = buildWorld(scene, { ARENA }); colliders = world.colliders; solids = world.solids;
  particles = createParticles(scene); decals = createDecals(scene); casings = createCasings(scene);
  discs = createDiscs(scene, world.heightAt, colliders);
  bar.style.width = '45%'; note.textContent = 'Waking the dead…'; await nextFrame();
  try { await loadAssets((k) => { bar.style.width = (45 + k * 45) + '%'; }); }
  catch (e) { console.error(e); note.innerHTML = '<span class="err">Could not load the game models (' + e.message + ').</span>'; return; }
  post.setQuality(settings.quality);
  player.pos.set(0, world.heightAt(0, 0), 0);
  // compile shaders up front so the first wave doesn't stutter
  const warm = spawnZombie(1, 6, { kind: 'brute' }); renderer.compile(scene, camera); scene.remove(warm.obj); zombies.length = 0; hitTargets.length = 0; alpha = null;
  bar.style.width = '100%'; await nextFrame();
  state = 'menu'; renderBest(); show('menu');
}
requestAnimationFrame(frame);
boot();
window.__game = { get frames() { return frameCount; }, renderer, player, zombies, stats, get pstat() { return pstat; }, get discs() { return discs; }, get phone() { return phone; }, get alpha() { return alpha; }, get score() { return score; }, get pickups() { return pickups; }, keys, get state() { return state; }, spawnZombie, shoot, shoveAttack, chooseUpgrade, openUpgrades, startWave, setAim: (x, y) => aimNDC.set(x, y), begin: () => { inputMode = 'keys'; begin(); } };
