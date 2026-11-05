// Visual effects: post-processing (bloom, colour grade, vignette, grain,
// damage aberration), pooled particles, ground decals and shell casings.
import * as THREE from 'three';
import { EffectComposer } from '../vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from '../vendor/three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from '../vendor/three/addons/postprocessing/OutputPass.js';

const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- post-processing
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uHurt: { value: 0 }, uLow: { value: 0 }, uGrain: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime, uHurt, uLow, uGrain; uniform vec2 uRes; varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float ab = 0.0015 + uHurt * 0.012;
      vec3 col = vec3(texture2D(tDiffuse, vUv + c * ab).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - c * ab).b);
      // grade: cool shadows, slightly warm highlights, a little desaturation
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, 0.82 - uLow * 0.6);
      col *= mix(vec3(0.92, 0.97, 1.06), vec3(1.05, 1.0, 0.94), smoothstep(0.2, 0.8, l));
      col = (col - 0.5) * 1.08 + 0.5;
      // vignette, red at the edges when hurt or low on health
      float v = smoothstep(0.85, 0.25, length(c * vec2(1.0, 0.85)));
      col *= mix(0.55, 1.0, v);
      float red = max(uHurt, uLow * (0.55 + 0.45 * sin(uTime * 6.0)));
      col = mix(col, vec3(0.45, 0.02, 0.02), (1.0 - v) * red * 0.85);
      // film grain
      col += (h(vUv * uRes + fract(uTime) * 91.7) - 0.5) * 0.045 * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export function createPost(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  const render = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 0.86);
  const output = new OutputPass();
  const grade = new ShaderPass(GradeShader);
  composer.addPass(render); composer.addPass(bloom); composer.addPass(output); composer.addPass(grade);
  let quality = 'high', hurt = 0;
  function setQuality(q) {
    quality = q;
    bloom.enabled = q !== 'low';
    grade.uniforms.uGrain.value = q === 'low' ? 0 : 1;
    renderer.shadowMap.enabled = q !== 'low';
    renderer.setPixelRatio(q === 'high' ? Math.min(devicePixelRatio, 1.75) : q === 'medium' ? Math.min(devicePixelRatio, 1.25) : 0.85);
    resize();
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }
  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(innerWidth, innerHeight);
    grade.uniforms.uRes.value.set(innerWidth, innerHeight);
  }
  addEventListener('resize', resize);
  resize();
  return {
    setQuality, get quality() { return quality; },
    hurt(k = 1) { hurt = Math.min(1, hurt + k); },
    render(t, dt, lowHp) {
      hurt = Math.max(0, hurt - dt * 2.5);
      grade.uniforms.uTime.value = t; grade.uniforms.uHurt.value = hurt; grade.uniforms.uLow.value = lowHp;
      composer.render(dt);
    },
  };
}

// ---------------------------------------------------------------- particles
export function createParticles(scene, max = 2500) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3), col = new Float32Array(max * 3), size = new Float32Array(max), alpha = new Float32Array(max);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 300 } }]),
    vertexShader: /* glsl */`
      attribute float size, alpha; attribute vec3 color; varying vec3 vColor; varying float vAlpha; uniform float uScale;
      #include <fog_pars_vertex>
      void main() { vColor = color; vAlpha = alpha; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uScale / -mvPosition.z; gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vAlpha;
      #include <fog_pars_fragment>
      void main() { vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
        gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.2, d));
        #include <fog_fragment>
      }`,
  });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false; scene.add(points);
  const P = Array.from({ length: max }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 9, drag: 0, r: 1, gc: 1, b: 1, s: 0.05, a: 1 }));
  let head = 0;
  function emit(o, n, f) {
    for (let i = 0; i < n; i++) {
      const p = P[head]; head = (head + 1) % max;
      Object.assign(p, { x: o.x, y: o.y, z: o.z, life: 0 }); f(p);
    }
  }
  const api = {
    blood(at, dir, amount = 1) {
      emit(at, Math.round(26 * amount), (p) => {
        const s = rand(1, 4) * amount;
        p.vx = dir.x * s + rand(-1.4, 1.4); p.vy = rand(0.5, 3.2); p.vz = dir.z * s + rand(-1.4, 1.4);
        p.g = 9.8; p.drag = 0.6; p.max = rand(0.4, 0.9); const k = rand(0.35, 0.6); p.r = k; p.gc = k * 0.06; p.b = k * 0.05; p.s = rand(0.025, 0.07); p.a = 0.95;
      });
    },
    dust(at, normal) {
      emit(at, 14, (p) => {
        p.vx = normal.x * rand(0.5, 2) + rand(-0.6, 0.6); p.vy = normal.y * rand(0.5, 2) + rand(0, 1); p.vz = normal.z * rand(0.5, 2) + rand(-0.6, 0.6);
        p.g = 2.5; p.drag = 1.8; p.max = rand(0.5, 1.1); const k = rand(0.45, 0.6); p.r = k; p.gc = k * 0.95; p.b = k * 0.85; p.s = rand(0.04, 0.1); p.a = 0.6;
      });
      emit(at, 5, (p) => { p.vx = rand(-3, 3); p.vy = rand(1, 4); p.vz = rand(-3, 3); p.g = 9; p.drag = 0; p.max = 0.25; p.r = 1; p.gc = 0.8; p.b = 0.4; p.s = 0.02; p.a = 1; });
    },
    sparkle(at, color, n = 18) {
      const c = new THREE.Color(color);
      emit(at, n, (p) => { const a = rand(0, 6.28), s = rand(0.6, 2); p.vx = Math.cos(a) * s; p.vy = rand(1, 3.5); p.vz = Math.sin(a) * s; p.g = 2; p.drag = 1; p.max = rand(0.6, 1.2); p.r = c.r; p.gc = c.g; p.b = c.b; p.s = rand(0.03, 0.06); p.a = 1; });
    },
    smoke(at, n = 3) {
      emit(at, n, (p) => { p.vx = rand(-0.2, 0.2); p.vy = rand(0.3, 0.7); p.vz = rand(-0.2, 0.2); p.g = -0.2; p.drag = 1.5; p.max = rand(0.4, 0.8); p.r = p.gc = p.b = rand(0.6, 0.75); p.s = rand(0.05, 0.1); p.a = 0.25; });
    },
    update(dt) {
      for (let i = 0; i < max; i++) {
        const p = P[i];
        if (p.life >= p.max) { size[i] = 0; continue; }
        p.life += dt;
        const dr = Math.exp(-p.drag * dt);
        p.vx *= dr; p.vz *= dr; p.vy = p.vy * dr - p.g * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const k = p.life / p.max;
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        col[i * 3] = p.r; col[i * 3 + 1] = p.gc; col[i * 3 + 2] = p.b;
        size[i] = p.s * (p.g < 0 ? 1 + k * 3 : 1); alpha[i] = p.a * (1 - k * k);
      }
      for (const a of ['position', 'color', 'size', 'alpha']) geo.attributes[a].needsUpdate = true;
      mat.uniforms.uScale.value = innerHeight * 0.6;
    },
  };
  return api;
}

// ---------------------------------------------------------------- blood decals on the ground
export function createDecals(scene, max = 90) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  for (let i = 0; i < 14; i++) {
    const r = i === 0 ? 34 : rand(5, 16), a = rand(0, 6.28), d = i === 0 ? 0 : rand(20, 50);
    const g = x.createRadialGradient(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 0, 64 + Math.cos(a) * d, 64 + Math.sin(a) * d, r);
    g.addColorStop(0, 'rgba(70,4,4,0.95)'); g.addColorStop(0.7, 'rgba(55,3,3,0.85)'); g.addColorStop(1, 'rgba(40,2,2,0)');
    x.fillStyle = g; x.beginPath(); x.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, r, 0, 7); x.fill();
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -2 });
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, max);
  im.count = 0; im.receiveShadow = true; im.frustumCulled = false; scene.add(im);
  let n = 0;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  return {
    add(x0, y0, z0, s = 1) {
      q.setFromAxisAngle(up, rand(0, 6.28));
      m.compose(new THREE.Vector3(x0, y0 + 0.03, z0), q, new THREE.Vector3(s, 1, s));
      im.setMatrixAt(n % max, m); n++; im.count = Math.min(n, max); im.instanceMatrix.needsUpdate = true;
    },
    clear() { n = 0; im.count = 0; },
  };
}

// ---------------------------------------------------------------- shell casings
export function createCasings(scene, max = 24) {
  const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.019, 6).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.9, roughness: 0.3 }), max);
  im.frustumCulled = false; scene.add(im);
  const C = Array.from({ length: max }, () => ({ live: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3() }));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), hide = new THREE.Matrix4().makeScale(0, 0, 0);
  let head = 0;
  for (let i = 0; i < max; i++) im.setMatrixAt(i, hide);
  return {
    eject(at, right, up) {
      const c = C[head]; head = (head + 1) % max;
      c.live = 3; c.p.copy(at); c.v.copy(right).multiplyScalar(rand(1.4, 2.2)).addScaledVector(up, rand(1.4, 2.2));
      c.w.set(rand(-20, 20), rand(-20, 20), rand(-20, 20));
    },
    update(dt, groundAt) {
      for (let i = 0; i < max; i++) {
        const c = C[i];
        if (c.live <= 0) { im.setMatrixAt(i, hide); continue; }
        c.live -= dt;
        c.v.y -= 9.8 * dt; c.p.addScaledVector(c.v, dt);
        const g = groundAt(c.p.x, c.p.z) + 0.005;
        if (c.p.y < g) { c.p.y = g; c.v.multiplyScalar(0.35); c.v.y = Math.abs(c.v.y) * 0.4; c.w.multiplyScalar(0.5); }
        c.r.x += c.w.x * dt; c.r.y += c.w.y * dt; c.r.z += c.w.z * dt;
        m.compose(c.p, q.setFromEuler(c.r), one); im.setMatrixAt(i, m);
      }
      im.instanceMatrix.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- muzzle flash
export function createMuzzleFlash() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,250,220,1)'); g.addColorStop(0.25, 'rgba(255,200,90,0.9)'); g.addColorStop(1, 'rgba(255,120,20,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  x.globalCompositeOperation = 'lighter'; x.fillStyle = 'rgba(255,220,140,0.7)';
  for (let i = 0; i < 6; i++) { x.save(); x.translate(32, 32); x.rotate(i / 6 * Math.PI * 2); x.beginPath(); x.moveTo(0, -3); x.lineTo(30, 0); x.lineTo(0, 3); x.fill(); x.restore(); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false, toneMapped: false }));
  sprite.renderOrder = 10; sprite.visible = false;
  return sprite;
}
