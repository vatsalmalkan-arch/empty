// Webcam + MediaPipe hand landmarker. Everything is served from ./vendor, so the
// game makes no outside requests.
import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

export async function startHands(video) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
  video.srcObject = stream;
  await video.play();

  const fileset = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
  const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('../vendor/mediapipe/hand_landmarker.task', import.meta.url).href, delegate },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let landmarker;
  try { landmarker = await make('GPU'); } catch (e) { landmarker = await make('CPU'); }

  const state = { hands: [], fps: 0, stream, frame: 0 };
  let lastVideoTime = -1, frames = 0, fpsT = performance.now();
  function tick() {
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const res = landmarker.detectForVideo(video, performance.now());
      state.hands = res.landmarks || [];
      state.frame++;
      frames++;
      const now = performance.now();
      if (now - fpsT > 1000) { state.fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
    }
    requestAnimationFrame(tick);
  }
  tick();
  return state;
}

// Draw the mirrored webcam and the hand skeletons into a small canvas.
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
export function drawPreview(canvas, video, hands, colorFor) {
  const c = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  c.save(); c.translate(W, 0); c.scale(-1, 1);
  if (video.readyState >= 2) c.drawImage(video, 0, 0, W, H); else { c.fillStyle = '#111'; c.fillRect(0, 0, W, H); }
  c.restore();
  c.fillStyle = 'rgba(10,12,16,.35)'; c.fillRect(0, 0, W, H);
  for (const lm of hands) {
    const col = colorFor(lm);
    c.strokeStyle = col; c.lineWidth = 2;
    for (const [a, b] of BONES) { c.beginPath(); c.moveTo((1 - lm[a].x) * W, lm[a].y * H); c.lineTo((1 - lm[b].x) * W, lm[b].y * H); c.stroke(); }
    c.fillStyle = col;
    for (const p of lm) { c.beginPath(); c.arc((1 - p.x) * W, p.y * H, 2.5, 0, 6.3); c.fill(); }
  }
}
