// In-app camera via getUserMedia (allows batch capture of several pages).
import { t } from './i18n.js';

let stream = null;
let track = null;

export function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export async function start(video) {
  stop();
  const attempts = [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr;
  for (const c of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (e) {
      lastErr = e;
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break;
    }
  }
  if (!stream) throw lastErr || new Error(t('cam.unavailable'));

  track = stream.getVideoTracks()[0];
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  try { await video.play(); } catch { /* iOS starts playback anyway */ }

  let torch = false;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    torch = !!caps.torch;
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
  } catch { /* optional */ }
  return { torch };
}

export function isActive() {
  return !!stream;
}

export function stop() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
}

export async function setTorch(on) {
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    return true;
  } catch {
    return false;
  }
}

// Shorter exposure against camera shake – only where the browser exposes manual exposure
// (e.g. Chrome on Android; iOS Safari currently does not). ISO is raised by the same factor,
// so the picture does not get darker. exposureTime is given in 100 µs units.
let exposureChanged = false;
export async function shortenExposure(maxSeconds = 1 / 125) {
  if (!track?.getCapabilities) return false;
  try {
    const caps = track.getCapabilities();
    const s = track.getSettings();
    if (!caps.exposureTime || !caps.iso || !caps.exposureMode?.includes('manual')) return false;
    if (!s.exposureTime || !s.iso) return false;
    const target = maxSeconds * 10000;
    if (s.exposureTime <= target) return false;
    const product = s.exposureTime * s.iso; // keep brightness constant
    const exposureTime = Math.max(target, product / caps.iso.max, caps.exposureTime.min);
    const iso = Math.min(caps.iso.max, product / exposureTime);
    await track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime, iso }] });
    exposureChanged = true;
    return true;
  } catch {
    return false;
  }
}

export async function restoreExposure() {
  if (!exposureChanged || !track) return;
  exposureChanged = false;
  try { await track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] }); } catch { /* ignore */ }
}

// Resolves when the next video frame is available.
export function nextFrame(video) {
  return new Promise((resolve) => {
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => resolve());
    else setTimeout(resolve, 40);
  });
}

export async function grab(video) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) throw new Error(t('cam.notReady'));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  c.width = c.height = 0;
  if (!blob) throw new Error(t('cam.captureFailed'));
  return blob;
}
