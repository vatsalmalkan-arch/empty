// Gesture logic for one frame of hand landmarks. Pure functions + small state
// objects, no DOM, so it can be unit-tested with synthetic hands.
//
// Landmarks are MediaPipe's 21 points in image coordinates (0..1). The webcam
// image is shown mirrored, so everything here works in mirrored x (mx = 1 - x):
// the hand on the right of the screen is the player's right hand.

export const L = { WRIST: 0, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_TIP: 12, RING_MCP: 13, RING_PIP: 14, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_TIP: 20 };

const pt = (lm, i) => ({ x: 1 - lm[i].x, y: lm[i].y });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function handSize(lm) { return dist(pt(lm, L.WRIST), pt(lm, L.MIDDLE_MCP)) || 1e-3; }

// A finger is extended when its tip is clearly further from the wrist than its middle joint.
export function fingers(lm) {
  const w = pt(lm, L.WRIST);
  const ext = (tip, pip) => dist(w, pt(lm, tip)) > dist(w, pt(lm, pip)) * 1.12;
  return {
    index: ext(L.INDEX_TIP, L.INDEX_PIP),
    middle: ext(L.MIDDLE_TIP, L.MIDDLE_PIP),
    ring: ext(L.RING_TIP, L.RING_PIP),
    pinky: ext(L.PINKY_TIP, L.PINKY_PIP),
  };
}

export function palmCenter(lm) {
  const ids = [L.WRIST, L.INDEX_MCP, L.MIDDLE_MCP, L.RING_MCP, L.PINKY_MCP];
  let x = 0, y = 0;
  for (const i of ids) { const p = pt(lm, i); x += p.x; y += p.y; }
  return { x: x / ids.length, y: y / ids.length };
}

// Split detected hands into { gun, move } by where they are on the mirrored screen.
// gunSide is 'right' or 'left'.
export function assignHands(hands, gunSide) {
  const list = hands.map((lm) => ({ lm, cx: palmCenter(lm).x }));
  let gun = null, move = null;
  if (list.length >= 2) {
    list.sort((a, b) => a.cx - b.cx);
    const leftOne = list[0].lm, rightOne = list[list.length - 1].lm;
    gun = gunSide === 'right' ? rightOne : leftOne;
    move = gunSide === 'right' ? leftOne : rightOne;
  } else if (list.length === 1) {
    const onRight = list[0].cx >= 0.5;
    if ((gunSide === 'right') === onRight) gun = list[0].lm; else move = list[0].lm;
  }
  return { gun, move };
}

// ---------------------------------------------------------------- gun hand
// Point the index finger to aim. Drop the thumb onto the side of the index
// finger (like a hammer falling) to fire. Close the hand into a fist to reload.
export function createGun(opts = {}) {
  return {
    cockAt: opts.cockAt ?? 0.62,    // thumb this far from the index base = hammer up
    fireAt: opts.fireAt ?? 0.42,    // thumb this close = hammer down, fires
    gain: opts.gain ?? 2.3,         // how far the crosshair travels per unit of hand movement
    center: opts.center ?? null,    // neutral aim point (mirrored image coords), set on calibrate
    smooth: opts.smooth ?? 0.4,
    cocked: false, aim: { x: 0.5, y: 0.5 }, thumb: 1, pose: false, fistSince: -1,
  };
}

// Returns { visible, pose, aim:{x,y} (0..1 screen), fire, reload, thumb, cocked }
export function updateGun(g, lm, t) {
  if (!lm) { g.cocked = false; g.fistSince = -1; return { visible: false, pose: false, aim: g.aim, fire: false, reload: false, thumb: g.thumb, cocked: false }; }
  const f = fingers(lm), size = handSize(lm);
  const pose = f.index && !f.ring && !f.pinky;          // middle may relax a little
  const fist = !f.index && !f.middle && !f.ring && !f.pinky;
  const thumbTip = pt(lm, L.THUMB_TIP);
  const thumb = Math.min(dist(thumbTip, pt(lm, L.INDEX_MCP)), dist(thumbTip, pt(lm, L.INDEX_PIP))) / size;
  g.thumb = thumb; g.pose = pose;

  let fire = false;
  if (pose) {
    if (thumb > g.cockAt) g.cocked = true;
    else if (g.cocked && thumb < g.fireAt) { fire = true; g.cocked = false; }
    // aim from the index fingertip, relative to the calibrated neutral point
    const tip = pt(lm, L.INDEX_TIP);
    const c = g.center || { x: tip.x, y: tip.y };
    if (!g.center) g.center = { x: tip.x, y: tip.y };
    const tx = clamp(0.5 + (tip.x - c.x) * g.gain, 0, 1), ty = clamp(0.5 + (tip.y - c.y) * g.gain, 0, 1);
    g.aim = { x: g.aim.x + (tx - g.aim.x) * g.smooth, y: g.aim.y + (ty - g.aim.y) * g.smooth };
  } else g.cocked = false;

  let reload = false;
  if (fist) { if (g.fistSince < 0) g.fistSince = t; else if (t - g.fistSince > 0.35) { reload = true; g.fistSince = Infinity; } }
  else g.fistSince = -1;

  return { visible: true, pose, aim: g.aim, fire, reload, thumb, cocked: g.cocked };
}

export function calibrateGun(g, lm) { if (lm) { const tip = pt(lm, L.INDEX_TIP); g.center = { x: tip.x, y: tip.y }; g.aim = { x: 0.5, y: 0.5 }; } }

// ---------------------------------------------------------------- move hand
// Open palm = a virtual joystick: the place where you open your hand is the
// centre; move it up/down/left/right from there to walk. Fist = stop (and
// re-centre). A quick upward flick = jump.
export function createMove(opts = {}) {
  return {
    dead: opts.dead ?? 0.22,       // dead zone, in hand sizes
    full: opts.full ?? 0.9,        // displacement for full speed
    flick: opts.flick ?? 3.2,      // upward speed (hand sizes per second) that counts as a jump
    neutral: null, lastY: null, lastT: null, jumpReadyAt: 0, state: 'none',
  };
}

// The OK sign (thumb and index tips touching, other three fingers up) takes out
// the phone. Moving the pinch up or down scrolls.
export function isOk(lm) {
  const f = fingers(lm), size = handSize(lm);
  return dist(pt(lm, L.THUMB_TIP), pt(lm, L.INDEX_TIP)) / size < 0.38 && f.middle && f.ring && f.pinky;
}

// Returns { visible, state: 'none'|'open'|'fist'|'phone'|'other', forward, strafe (-1..1), jump, pinchY }
export function updateMove(m, lm, t) {
  if (!lm) { m.lastY = null; m.state = 'none'; return { visible: false, state: 'none', forward: 0, strafe: 0, jump: false }; }
  const f = fingers(lm), size = handSize(lm), c = palmCenter(lm);
  const n = (f.index ? 1 : 0) + (f.middle ? 1 : 0) + (f.ring ? 1 : 0) + (f.pinky ? 1 : 0);
  if (isOk(lm)) {
    m.state = 'phone'; m.neutral = null; m.lastY = null;
    const tip = pt(lm, L.INDEX_TIP);
    return { visible: true, state: 'phone', forward: 0, strafe: 0, jump: false, pinchY: tip.y / size };
  }
  const state = n >= 3 ? 'open' : n <= 1 ? 'fist' : 'other';
  m.state = state;

  let jump = false;
  if (m.lastY != null && t > m.lastT) {
    const vUp = (m.lastY - c.y) / (t - m.lastT) / size;     // hand sizes per second, upward
    if (vUp > m.flick && t >= m.jumpReadyAt && state !== 'fist') { jump = true; m.jumpReadyAt = t + 0.8; }
  }
  m.lastY = c.y; m.lastT = t;

  if (state === 'fist') { m.neutral = null; return { visible: true, state, forward: 0, strafe: 0, jump }; }
  if (state !== 'open') return { visible: true, state, forward: 0, strafe: 0, jump };
  if (!m.neutral) m.neutral = { x: c.x, y: c.y };
  // during a jump flick, don't let the upward motion read as "forward"
  if (t < m.jumpReadyAt - 0.5) return { visible: true, state, forward: 0, strafe: 0, jump };
  const axis = (d) => { const a = Math.abs(d); if (a < m.dead) return 0; return Math.sign(d) * Math.min(1, (a - m.dead) / (m.full - m.dead)); };
  return { visible: true, state, forward: axis((m.neutral.y - c.y) / size), strafe: axis((c.x - m.neutral.x) / size), jump };
}
