// The gloomy forest: grey apocalyptic sky, rolling ground, EZ-Tree trees
// (instanced), noise-sculpted boulders, dead grass, falling ash, a few wrecks
// and burning barrels.
import * as THREE from 'three';
import { Tree } from '../vendor/ez-tree/ez-tree.es.js';

const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- noise
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, o = 4) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < o; i++) { s += a * vnoise(x * f, y * f); f *= 2; a *= 0.5; } return s; }
function noise3(x, y, z) { return (vnoise(x + z * 1.7, y - z * 0.9) + vnoise(y + 3.1, z + x * 0.7)) * 0.5; }

// ---------------------------------------------------------------- terrain height
export function heightAt(x, z, arena = 52) {
  const d = Math.hypot(x, z);
  const hills = (fbm(x * 0.035, z * 0.035) - 0.5) * 3.2 + (fbm(x * 0.12 + 40, z * 0.12) - 0.5) * 0.5;
  const flatten = Math.min(1, Math.max(0, (d - 6) / 14));          // a level clearing where you start
  const rise = Math.max(0, d - arena) * 0.09;                      // the land climbs beyond the arena
  return hills * flatten + rise;
}

// ---------------------------------------------------------------- sky
function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTime: { value: 0 }, uFog: { value: new THREE.Color(0x5b5a57) } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uFog; varying vec3 vDir;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        float up = clamp(d.y, -1.0, 1.0);
        vec3 zenith = vec3(0.17, 0.17, 0.18), horizon = vec3(0.42, 0.41, 0.39);
        vec3 col = mix(horizon, zenith, smoothstep(0.0, 0.55, up));
        // heavy, slow, layered overcast
        vec2 uv = d.xz / (max(up, 0.02) + 0.18);
        float c = fbm(uv * 1.3 + vec2(uTime * 0.012, uTime * 0.004));
        float c2 = fbm(uv * 3.1 - vec2(uTime * 0.02, 0.0));
        float cloud = smoothstep(0.35, 0.8, c * 0.75 + c2 * 0.35);
        col = mix(col, vec3(0.24, 0.24, 0.25), cloud * 0.85 * smoothstep(-0.02, 0.15, up));
        col += vec3(0.05) * smoothstep(0.55, 0.9, c2) * smoothstep(0.1, 0.4, up);   // pale breaks
        // a burning glow on one horizon
        float glow = pow(max(dot(normalize(d.xz + 1e-4), normalize(vec2(-0.8, -0.6))), 0.0), 5.0) * (1.0 - smoothstep(-0.02, 0.22, up));
        col = mix(col, vec3(0.55, 0.27, 0.15), glow * 0.55);
        col = mix(col, uFog, 1.0 - smoothstep(-0.05, 0.12, up));             // melt into the fog
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 40, 20), mat);
  sky.renderOrder = -1;
  return sky;
}

// ---------------------------------------------------------------- trees
function makeTreeTemplate(preset, tweak, height) {
  const t = new Tree();
  t.loadPreset(preset);
  tweak(t.options);
  t.generate();
  t.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(t.branchesMesh);
  const s = height / (box.max.y - box.min.y);
  const hasLeaves = t.leavesMesh && t.leavesMesh.geometry.index && t.leavesMesh.geometry.index.count > 0;
  return { tree: t, s, hasLeaves };
}

function instance(template, placements, shadows) {
  const out = [];
  const meshes = [template.tree.branchesMesh, template.hasLeaves ? template.tree.leavesMesh : null].filter(Boolean);
  for (const src of meshes) {
    const im = new THREE.InstancedMesh(src.geometry, src.material, placements.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    placements.forEach((p, i) => {
      e.set(rand(-0.04, 0.04), p.rot, rand(-0.04, 0.04)); q.setFromEuler(e);
      m.compose(new THREE.Vector3(p.x, p.y - 0.15, p.z), q, new THREE.Vector3().setScalar(template.s * p.k));
      im.setMatrixAt(i, m);
    });
    im.castShadow = shadows && src === template.tree.branchesMesh;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    out.push(im);
  }
  return out;
}

// ---------------------------------------------------------------- boulders
function makeBoulderGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + (noise3(v.x * 1.4 + seed, v.y * 1.4, v.z * 1.4) - 0.5) * 0.7 + (noise3(v.x * 4 + seed, v.y * 4, v.z * 4) - 0.5) * 0.18;
    v.multiplyScalar(k); v.y *= 0.72; if (v.y < -0.35) v.y = -0.35 + (v.y + 0.35) * 0.2;   // flat-ish bottom
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const ng = g.index ? g.toNonIndexed() : g; ng.computeVertexNormals();
  // moss on the faces that look up, grey stone elsewhere
  const n = ng.attributes.normal, col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const up = n.getY(i), moss = Math.max(0, up - 0.45) * 1.6, grit = 0.85 + Math.random() * 0.15;
    col[i * 3] = (0.40 - moss * 0.12) * grit; col[i * 3 + 1] = (0.40 + moss * 0.03) * grit; col[i * 3 + 2] = (0.39 - moss * 0.13) * grit;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return ng;
}

// ---------------------------------------------------------------- build
export function buildWorld(scene, { ARENA = 52 } = {}) {
  const colliders = [], solids = [], fires = [], animated = [];
  const FOG = 0x5b5a57;
  scene.background = new THREE.Color(FOG);
  scene.fog = new THREE.FogExp2(FOG, 0.026);
  const sky = makeSky(); scene.add(sky);

  // ground
  const g = new THREE.PlaneGeometry(320, 320, 160, 160);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position, colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, heightAt(x, z, ARENA));
    const m = fbm(x * 0.08, z * 0.08), d = fbm(x * 0.4 + 9, z * 0.4);
    // mud, dead grass and dark moss
    const mud = [0.23, 0.21, 0.18], grass = [0.36, 0.34, 0.25], moss = [0.18, 0.21, 0.16];
    const a = Math.min(1, Math.max(0, (m - 0.42) * 3)), b = Math.min(1, Math.max(0, (0.5 - d) * 2));
    for (let c = 0; c < 3; c++) colors[i * 3 + c] = (mud[c] * (1 - a) + grass[c] * a) * (1 - b * 0.4) + moss[c] * b * 0.4;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground); solids.push(ground);

  const spot = (min, max, avoid = 0) => {
    for (let k = 0; k < 40; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(rand(min * min, max * max));
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (colliders.every((c) => Math.hypot(c.x - x, c.z - z) > c.r + avoid)) return [x, z];
    }
    return null;
  };

  // trees: a handful of EZ-Tree templates, each drawn many times with instancing
  const lowDetail = (o) => { o.branch.segments = { 0: 6, 1: 4, 2: 3, 3: 3 }; o.branch.sections = { 0: 8, 1: 5, 2: 4, 3: 3 }; };
  const farDetail = (o) => { o.branch.segments = { 0: 4, 1: 3, 2: 3, 3: 3 }; o.branch.sections = { 0: 5, 1: 3, 2: 2, 3: 2 }; o.leaves.count = Math.ceil(o.leaves.count * 0.5); if (o.branch.levels > 2) o.branch.levels = 2; };
  const deadBark = (o) => { o.bark.tint = 0x6f6a64; };
  const kinds = [
    { preset: 'Oak Large', h: [9, 13], k: 'dead', tweak: (o) => { lowDetail(o); deadBark(o); o.leaves.count = 0; o.branch.gnarliness = { 0: 0.15, 1: 0.25, 2: 0.3, 3: 0.3 }; } },
    { preset: 'Ash Large', h: [10, 15], k: 'dead', tweak: (o) => { lowDetail(o); deadBark(o); o.leaves.count = 0; } },
    { preset: 'Ash Medium', h: [7, 10], k: 'dead', tweak: (o) => { lowDetail(o); deadBark(o); o.leaves.count = 2; o.leaves.tint = 0x5e5236; o.seed = 77; } },
    { preset: 'Pine Large', h: [14, 20], k: 'pine', tweak: (o) => { lowDetail(o); o.bark.tint = 0x5a524a; o.leaves.tint = 0x37453a; o.leaves.count = 9; } },
    { preset: 'Pine Medium', h: [10, 14], k: 'pine', tweak: (o) => { lowDetail(o); o.bark.tint = 0x5a524a; o.leaves.tint = 0x3c4a3c; o.leaves.count = 12; o.seed = 1234; } },
    { preset: 'Aspen Medium', h: [9, 13], k: 'thin', tweak: (o) => { lowDetail(o); o.bark.tint = 0x9a948a; o.leaves.count = 6; o.leaves.tint = 0x7a6a3e; } },
  ];
  const templates = kinds.map((kd) => ({ ...kd, t: makeTreeTemplate(kd.preset, kd.tweak, (kd.h[0] + kd.h[1]) / 2) }));
  const farTemplates = kinds.map((kd) => ({ ...kd, t: makeTreeTemplate(kd.preset, (o) => { kd.tweak(o); farDetail(o); }, (kd.h[0] + kd.h[1]) / 2) }));
  const trunkProxies = [];
  const plant = (count, min, max, shadows, blocks, templates) => {
    const per = templates.map(() => []);
    for (let i = 0; i < count; i++) {
      const s = spot(min, max, 0.6); if (!s) continue;
      const ti = Math.random() < 0.45 ? (Math.random() < 0.5 ? 3 : 4) : (Math.random() * templates.length) | 0;
      const tp = templates[ti], k = rand(tp.h[0], tp.h[1]) / ((tp.h[0] + tp.h[1]) / 2);
      const [x, z] = s, y = heightAt(x, z, ARENA);
      per[ti].push({ x, y, z, rot: rand(0, 6.28), k });
      if (blocks) { const r = 0.32 * k * (tp.k === 'pine' ? 1.1 : 1); colliders.push({ x, z, r }); trunkProxies.push({ x, y, z, r, h: 6 * k }); }
    }
    templates.forEach((tp, i) => { if (per[i].length) for (const im of instance(tp.t, per[i], shadows)) scene.add(im); });
  };
  plant(60, 9, ARENA - 1, true, true, templates);        // inside the arena: shadows and collisions
  plant(75, ARENA + 1, 85, false, false, farTemplates);    // the dark wall of forest beyond, hidden by fog further out
  animated.push(...templates.map((tp) => tp.t.tree), ...farTemplates.map((tp) => tp.t.tree));
  // invisible trunk cylinders: cheap targets for bullets
  if (trunkProxies.length) {
    const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshBasicMaterial({ visible: false }), trunkProxies.length);
    const m = new THREE.Matrix4();
    trunkProxies.forEach((t, i) => { m.compose(new THREE.Vector3(t.x, t.y + t.h / 2, t.z), new THREE.Quaternion(), new THREE.Vector3(t.r, t.h, t.r)); im.setMatrixAt(i, m); });
    im.computeBoundingSphere(); scene.add(im); solids.push(im);
  }

  // boulders: six sculpted shapes, scattered singly and in clusters
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  const rockGeos = Array.from({ length: 6 }, (_, i) => makeBoulderGeometry(i * 13.7));
  const rockPlace = rockGeos.map(() => []);
  const putRock = (x, z, s) => { const y = heightAt(x, z, ARENA); rockPlace[(Math.random() * 6) | 0].push({ x, y: y + s * 0.15, z, s, rot: rand(0, 6.28) }); if (s > 0.5) colliders.push({ x, z, r: s * 0.95 }); };
  for (let i = 0; i < 26; i++) { const c = spot(7, ARENA - 2, 1.5); if (!c) continue; const n = 1 + ((Math.random() * 4) | 0); for (let k = 0; k < n; k++) putRock(c[0] + rand(-2, 2), c[1] + rand(-2, 2), rand(0.5, 2.4) * (k ? 0.6 : 1)); }
  for (let i = 0; i < 60; i++) { const c = spot(5, 80, 0.3); if (c) putRock(c[0], c[1], rand(0.2, 0.6)); }
  rockGeos.forEach((geo, i) => {
    const list = rockPlace[i]; if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, rockMat, list.length), m = new THREE.Matrix4(), q = new THREE.Quaternion();
    list.forEach((r, k) => { q.setFromEuler(new THREE.Euler(rand(-0.15, 0.15), r.rot, rand(-0.15, 0.15))); m.compose(new THREE.Vector3(r.x, r.y, r.z), q, new THREE.Vector3(r.s, r.s * rand(0.8, 1.15), r.s)); im.setMatrixAt(k, m); });
    im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); scene.add(im); solids.push(im);
  });

  // dead grass tufts
  {
    const blade = new THREE.BufferGeometry();
    const v = [];
    for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2, r = 0.08, lean = rand(0.05, 0.18); v.push(Math.cos(a) * r, 0, Math.sin(a) * r, Math.cos(a + 0.5) * r, 0, Math.sin(a + 0.5) * r, Math.cos(a) * lean, rand(0.3, 0.55), Math.sin(a) * lean); }
    blade.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); blade.computeVertexNormals();
    const n = 2600, im = new THREE.InstancedMesh(blade, new THREE.MeshStandardMaterial({ color: 0x6f6548, roughness: 1, side: THREE.DoubleSide }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * (ARENA + 8), x = Math.cos(a) * r, z = Math.sin(a) * r;
      q.setFromEuler(new THREE.Euler(0, rand(0, 6.28), 0)); m.compose(new THREE.Vector3(x, heightAt(x, z, ARENA), z), q, new THREE.Vector3().setScalar(rand(0.7, 1.6)));
      im.setMatrixAt(i, m); im.setColorAt(i, col.setHSL(0.12, 0.2, rand(0.22, 0.38)));
    }
    im.receiveShadow = true; scene.add(im);
  }

  // fallen logs
  const bark = new THREE.MeshStandardMaterial({ color: 0x4a423a, roughness: 1, flatShading: true });
  for (let i = 0; i < 9; i++) {
    const c = spot(8, ARENA - 3, 1); if (!c) continue;
    const len = rand(3, 6), log = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.32, len, 7), bark);
    const rot = rand(0, 6.28); log.rotation.set(0, rot, Math.PI / 2); log.position.set(c[0], heightAt(c[0], c[1], ARENA) + 0.25, c[1]);
    log.castShadow = log.receiveShadow = true; scene.add(log); solids.push(log);
    const dx = Math.cos(rot), dz = -Math.sin(rot);
    for (let s = -len / 2; s <= len / 2; s += 0.6) colliders.push({ x: c[0] + dx * s, z: c[1] + dz * s, r: 0.4 });
  }

  // a few rusted wrecks
  const flat = (color) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 });
  for (let i = 0; i < 4; i++) {
    const c = spot(10, ARENA - 6, 2.5); if (!c) continue;
    const car = new THREE.Group(), col = [0x5a3a2c, 0x3e4448, 0x5c5446][i % 3];
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.9, 1.9), flat(col)); body.position.y = 0.75; car.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.75, 1.7), flat(0x1f2224)); cab.position.set(-0.2, 1.55, 0); car.add(cab);
    for (const [wx, wz] of [[-1.4, 1], [1.4, 1], [-1.4, -1], [1.4, -1]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.3, 8), flat(0x141516)); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.38, wz * 0.95); car.add(w); }
    car.rotation.set(0, rand(0, 6.28), rand(-0.1, 0.1)); car.position.set(c[0], heightAt(c[0], c[1], ARENA), c[1]);
    car.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; solids.push(o); } });
    scene.add(car); colliders.push({ x: c[0], z: c[1], r: 2.1 });
  }

  // burning barrels: the only warm light in the grey
  for (const [x, z] of [[4, -6], [-9, 7], [14, 12], [-16, -14]]) {
    const y = heightAt(x, z, ARENA), grp = new THREE.Group();
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.9, 10), flat(0x3a2b24)); b.position.y = 0.45; b.castShadow = true; grp.add(b);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.6, 7), new THREE.MeshBasicMaterial({ color: 0xff9a3c })); flame.position.y = 1.15; grp.add(flame);
    const light = new THREE.PointLight(0xff8a3c, 7, 16, 1.6); light.position.y = 1.6; grp.add(light);
    grp.position.set(x, y, z); scene.add(grp); solids.push(b); colliders.push({ x, z, r: 0.45 });
    fires.push({ flame, light, seed: Math.random() * 10 });
  }

  // falling ash
  const ASH = 1800, ashGeo = new THREE.BufferGeometry(), ashPos = new Float32Array(ASH * 3), ashSeed = new Float32Array(ASH);
  for (let i = 0; i < ASH; i++) { ashPos[i * 3] = rand(-25, 25); ashPos[i * 3 + 1] = rand(0, 18); ashPos[i * 3 + 2] = rand(-25, 25); ashSeed[i] = Math.random() * 10; }
  ashGeo.setAttribute('position', new THREE.BufferAttribute(ashPos, 3));
  const ash = new THREE.Points(ashGeo, new THREE.PointsMaterial({ color: 0xcfcac2, size: 0.06, transparent: true, opacity: 0.7, depthWrite: false }));
  ash.frustumCulled = false; scene.add(ash);

  // gloomy light: a weak sun through the haze, a grey sky fill
  scene.add(new THREE.HemisphereLight(0xa3a29e, 0x2c2824, 1.1));
  const sun = new THREE.DirectionalLight(0xd8cfc0, 1.1);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 140 });
  scene.add(sun, sun.target);

  function update(t, dt, cam) {
    sky.position.copy(cam.position); sky.material.uniforms.uTime.value = t;
    sun.position.set(cam.position.x - 30, cam.position.y + 45, cam.position.z - 20); sun.target.position.set(cam.position.x, 0, cam.position.z);
    for (const tr of animated) tr.update?.(t);
    for (const f of fires) { const k = 0.8 + 0.25 * Math.sin(t * 13 + f.seed) * Math.sin(t * 7.3 + f.seed); f.light.intensity = 7 * k; f.flame.scale.set(1, k, 1); }
    // ash drifts down and sideways around the player, wrapping in a box
    const a = ashGeo.attributes.position.array;
    for (let i = 0; i < ASH; i++) {
      let x = a[i * 3] - 0.3 * dt + Math.sin(t * 0.7 + ashSeed[i]) * 0.2 * dt, y = a[i * 3 + 1] - (0.35 + ashSeed[i] * 0.03) * dt, z = a[i * 3 + 2] + Math.cos(t * 0.5 + ashSeed[i]) * 0.2 * dt;
      if (y < 0) y += 18;
      a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z;
    }
    ash.position.set(Math.round(cam.position.x / 50) * 50, cam.position.y - 6, Math.round(cam.position.z / 50) * 50);
    // keep the ash box centred on the player without visible jumps
    for (let i = 0; i < ASH; i++) {
      const wx = a[i * 3] + ash.position.x - cam.position.x, wz = a[i * 3 + 2] + ash.position.z - cam.position.z;
      if (wx > 25) a[i * 3] -= 50; else if (wx < -25) a[i * 3] += 50;
      if (wz > 25) a[i * 3 + 2] -= 50; else if (wz < -25) a[i * 3 + 2] += 50;
    }
    ashGeo.attributes.position.needsUpdate = true;
  }
  return { colliders, solids, update, heightAt: (x, z) => heightAt(x, z, ARENA) };
}
