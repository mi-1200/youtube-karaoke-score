'use strict';
/* テスト用のヘルパー（合成音声・SMF生成・歌唱フレームのシミュレーション） */

// 決定的な疑似乱数（mulberry32）
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 合成波形: amps[k] が第(k+1)倍音の振幅
function harmonicBuf(f, sr, amps, n = 2048, phase = 0.4) {
  const b = new Float32Array(n);
  for (let k = 0; k < amps.length; k++) {
    const h = k + 1;
    if (h * f >= sr / 2) break;
    for (let i = 0; i < n; i++) b[i] += amps[k] * Math.sin(2 * Math.PI * h * f * i / sr + phase * h * 1.7);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(b[i]));
  for (let i = 0; i < n; i++) b[i] *= 0.5 / peak;
  return b;
}
const sine = (f, sr, n) => harmonicBuf(f, sr, [1], n);
const saw = (f, sr, n) => harmonicBuf(f, sr, Array.from({ length: 60 }, (_, k) => 1 / (k + 1)), n);
// 声っぽい：基音は弱め、第2倍音が最も強い
const voice = (f, sr, n) => harmonicBuf(f, sr, [0.4, 1.0, 0.6, 0.35, 0.25, 0.15, 0.1, 0.06], n);

/* ---------- SMF ---------- */
function vlq(x) {
  const out = [x & 0x7f];
  x >>>= 7;
  while (x > 0) { out.unshift((x & 0x7f) | 0x80); x >>>= 7; }
  return out;
}
const u32 = (x) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255];
const u16 = (x) => [(x >>> 8) & 255, x & 255];
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
// events: [[deltaTicks, ...bytes]] — bytes はそのまま書く（ランニングステータスも表現可能）
function track(events) {
  const body = [];
  for (const [dt, ...bytes] of events) body.push(...vlq(dt), ...bytes);
  body.push(0, 0xff, 0x2f, 0); // End of track
  return [...ascii('MTrk'), ...u32(body.length), ...body];
}
function smf(format, division, tracks) {
  const bytes = [...ascii('MThd'), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(division)];
  for (const t of tracks) bytes.push(...t);
  return new Uint8Array(bytes).buffer;
}
const tempo = (uspq) => [0xff, 0x51, 3, (uspq >>> 16) & 255, (uspq >>> 8) & 255, uspq & 255];
const trackName = (s) => [0xff, 0x03, s.length, ...ascii(s)];

/* ---------- 歌唱シミュレーション ---------- */
// メロディ（4/4、BPM120相当の音符列）。ハ長調中心。
function makeMelody(seconds, seed = 7) {
  const r = rng(seed);
  const scale = [60, 62, 64, 65, 67, 69, 71, 72];
  const notes = [];
  let t = 2.0;
  let idx = 3;
  while (t < seconds - 2) {
    const phraseLen = 6 + Math.floor(r() * 5);
    for (let i = 0; i < phraseLen && t < seconds - 2; i++) {
      idx = Math.max(0, Math.min(scale.length - 1, idx + Math.floor(r() * 5) - 2));
      const d = [0.25, 0.5, 0.5, 0.75, 1.0][Math.floor(r() * 5)] * (i === phraseLen - 1 ? 3 : 1);
      notes.push({ t, d: d * 0.95, midi: scale[idx] });
      t += d;
    }
    t += 1.0; // 息継ぎ
  }
  return notes;
}

/*
 * guide に沿って歌ったフレーム（60fps）を作る。
 *  offset: 一律の音程ずれ（半音）, noise: フレーム毎のゆらぎ（半音, 標準偏差）
 *  lag: 歌い出しの遅れ（秒）, octave: オクターブ移動, wander: 音毎のランダムずれ（標準偏差）
 *  vibrato: ロングトーン終盤のビブラート振幅（半音）, dropout: 無声化確率
 */
function singFrames(guide, o = {}) {
  const r = rng(o.seed || 11);
  const fps = 60, end = guide.length ? guide[guide.length - 1].t + guide[guide.length - 1].d + 1 : 10;
  const frames = [];
  const noteErr = guide.map(() => (o.wander || 0) * gauss(r));
  let drift = 0;
  for (let i = 0; i * (1 / fps) < end; i++) {
    const t = i / fps;
    const ts = t - (o.lag || 0);
    // 遅れて歌う場合は「歌い手にとっての時刻」で音符を探す
    let idx = -1;
    for (let k = 0; k < guide.length; k++) { const n = guide[k]; if (ts >= n.t && ts < n.t + n.d) { idx = k; break; } }
    const phraseVol = 0.05 + 0.04 * Math.sin(t / 7) + 0.02 * Math.sin(t / 2.3);
    if (idx < 0 || r() < (o.dropout || 0)) { frames.push({ t, midi: null, rms: 0.002 }); continue; }
    const n = guide[idx];
    drift = drift * 0.9 + (o.noise || 0) * gauss(r) * 0.45;
    let m = n.midi + (o.offset || 0) + 12 * (o.octave || 0) + noteErr[idx] + drift;
    const into = ts - n.t;
    if (o.vibrato && n.d > 0.9 && into > 0.5) m += o.vibrato * Math.sin(2 * Math.PI * 5.5 * into);
    if (o.slide && into < 0.06) m -= o.slide * (1 - into / 0.06);
    frames.push({ t, midi: m, rms: Math.max(0.003, phraseVol * (1 + 0.1 * gauss(r))) });
  }
  return frames;
}

module.exports = { rng, gauss, harmonicBuf, sine, saw, voice, vlq, track, smf, tempo, trackName, makeMelody, singFrames };
