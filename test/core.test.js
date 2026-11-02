'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../core.js');
const H = require('./helpers.js');

/* ================= 1. detectPitch ================= */
test('detectPitch: sine / sawtooth / voice-like 80–1000 Hz within 1%, no octave errors', () => {
  const fails = [];
  for (const sr of [44100, 48000]) {
    for (const [kind, gen] of [['sine', H.sine], ['saw', H.saw], ['voice', H.voice]]) {
      for (let f = 80; f <= 1000.5; f *= 1.025) {
        const r = K.detectPitch(gen(f, sr, 2048), sr);
        const err = Math.abs(r.freq - f) / f;
        if (!(err < 0.01)) fails.push(`${sr} ${kind} ${f.toFixed(1)}Hz -> ${r.freq.toFixed(1)}`);
      }
    }
  }
  assert.deepEqual(fails, []);
});

test('detectPitch: very weak fundamental (strong 2nd/3rd harmonic) has no octave errors', () => {
  const fails = [];
  for (const sr of [44100, 48000]) {
    for (const amps of [[0.15, 1, 0.3], [0.1, 1, 0.8, 0.5], [0.3, 1, 1, 0.6, 0.4]]) {
      for (let f = 80; f <= 1000.5; f *= 1.05) {
        const r = K.detectPitch(H.harmonicBuf(f, sr, amps, 2048), sr);
        if (!(Math.abs(r.freq - f) / f < 0.01)) fails.push(`${sr} [${amps}] ${f.toFixed(1)} -> ${r.freq.toFixed(1)}`);
      }
    }
  }
  assert.deepEqual(fails, []);
});

test('detectPitch: voice-like signal with additive noise (SNR ~20 dB)', () => {
  const r = H.rng(5);
  const fails = [];
  for (const sr of [44100, 48000]) {
    for (let f = 80; f <= 1000.5; f *= 1.05) {
      const b = H.voice(f, sr, 2048);
      for (let i = 0; i < b.length; i++) b[i] += 0.03 * (r() * 2 - 1);
      const p = K.detectPitch(b, sr);
      if (!(Math.abs(p.freq - f) / f < 0.01)) fails.push(`${sr} ${f.toFixed(1)} -> ${p.freq.toFixed(1)}`);
    }
  }
  assert.deepEqual(fails, []);
});

test('detectPitch: silence and white noise return freq 0', () => {
  for (const sr of [44100, 48000]) {
    assert.equal(K.detectPitch(new Float32Array(2048), sr).freq, 0);
    for (let seed = 1; seed <= 20; seed++) {
      const r = H.rng(seed), b = new Float32Array(2048);
      for (let i = 0; i < b.length; i++) b[i] = 0.3 * (r() * 2 - 1);
      assert.equal(K.detectPitch(b, sr).freq, 0, `noise seed ${seed} @${sr}`);
    }
  }
});

test('detectPitch: rmsGate option gates quiet input; clarity/rms reported', () => {
  const b = H.sine(220, 44100, 2048);
  for (let i = 0; i < b.length; i++) b[i] *= 0.02; // rms ≈ 0.007
  assert.equal(K.detectPitch(b, 44100).freq, 0);
  const p = K.detectPitch(b, 44100, { rmsGate: 0.001 });
  assert.ok(Math.abs(p.freq - 220) < 2);
  assert.ok(p.clarity > 0.9 && p.clarity <= 1);
  assert.ok(Math.abs(p.rms - 0.5 * 0.02 / Math.SQRT2) < 1e-3);
});

test('freqToMidi / midiName', () => {
  assert.equal(K.freqToMidi(440), 69);
  assert.ok(Math.abs(K.freqToMidi(261.6256) - 60) < 1e-4);
  assert.equal(K.midiName(60), 'ド4');
  assert.equal(K.midiName(69), 'ラ4');
  assert.equal(K.midiName(61, true), 'C#4');
  assert.equal(K.midiName(59.6, true), 'C4');
  assert.equal(K.midiName(-1, true), 'B-2');
});

/* ================= 2. parseVideoId ================= */
test('parseVideoId: accepted forms', () => {
  const id = 'dQw4w9WgXcQ';
  const ok = [
    id,
    `  ${id}  `,
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `https://youtube.com/watch?feature=share&v=${id}`,
    `http://youtube.com/watch?v=${id}`,
    `youtube.com/watch?v=${id}`,
    `www.youtube.com/watch?v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&si=xyz`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=AbCdEf&t=10`,
    `youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://youtube.com/shorts/${id}?feature=share`,
    `https://www.youtube.com/embed/${id}?autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/v/${id}`,
  ];
  for (const s of ok) assert.equal(K.parseVideoId(s), id, s);
  assert.equal(K.parseVideoId('abc_DEF-123'), 'abc_DEF-123');
});

test('parseVideoId: junk returns null', () => {
  const bad = [
    '', null, undefined, 'hello', 'hello world', 'こんにちは',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/', 'https://www.youtube.com/watch?v=short',
    'https://youtu.be/', 'https://youtu.be/abc',
    'https://www.youtube.com/channel/UC1234567890abcdefghij',
    'dQw4w9WgXcQextra',
    'https://www.google.com/search?q=abcdefghijklmnop',
  ];
  for (const s of bad) assert.equal(K.parseVideoId(s), null, String(s));
});

/* ================= 3. parseLrc / formatStamp ================= */
test('parseLrc: basic, multiple stamps per line, sorting, metadata ignored', () => {
  const text = [
    '[ti:テスト曲]',
    '[ar:歌手]',
    '[00:12.00]はじめの歌詞',
    '[00:05.50][01:05.25]サビ　くりかえし ',
    '',
    'タイムスタンプなしの行',
    '[1:02.5]分が1桁',
    '[00:20]小数なし',
    '[00:30.00]',
  ].join('\r\n');
  const lines = K.parseLrc(text);
  assert.deepEqual(lines.map((l) => [l.t, l.text]), [
    [5.5, 'サビ　くりかえし'],
    [12, 'はじめの歌詞'],
    [20, '小数なし'],
    [30, ''],
    [62.5, '分が1桁'],
    [65.25, 'サビ　くりかえし'],
  ]);
  assert.deepEqual(K.parseLrc(''), []);
  assert.deepEqual(K.parseLrc(null), []);
});

test('formatStamp: format and round-trip through parseLrc', () => {
  assert.equal(K.formatStamp(0), '[00:00.00]');
  assert.equal(K.formatStamp(-3), '[00:00.00]');
  assert.equal(K.formatStamp(5.5), '[00:05.50]');
  assert.equal(K.formatStamp(65.25), '[01:05.25]');
  assert.equal(K.formatStamp(600), '[10:00.00]');
  for (const t of [0, 0.01, 1.23, 9.99, 59.99, 60, 61.5, 125.37, 3599.5]) {
    const s = K.formatStamp(t);
    assert.match(s, /^\[\d{2,}:\d{2}\.\d{2}\]$/);
    const [l] = K.parseLrc(s + 'x');
    assert.ok(Math.abs(l.t - t) < 0.006, `${t} -> ${s} -> ${l.t}`);
  }
  // 丸めで 60 秒にならないこと
  const s = K.formatStamp(59.999);
  assert.ok(!/:60\./.test(s), s);
  assert.ok(Math.abs(K.parseLrc(s + 'x')[0].t - 59.999) < 0.006, s);
});

/* ================= 4. parseMidi / toMonophonic ================= */
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('parseMidi: format 0 with running status and vel-0 note-off', () => {
  // 480 tpq, 120 BPM（デフォルト）→ 1拍 0.5秒
  const trk = H.track([
    [0, ...H.trackName('Melody')],
    [0, 0x90, 60, 100], // note on C4
    [480, 62, 90], // running status: note on D4 (C4 は鳴ったまま)
    [0, 60, 0], // running status vel 0 = C4 off @ 1拍
    [480, 62, 0], // D4 off @ 2拍
    [240, 0x80, 64, 64], // 0x80 note off（対応する on なし、無視される）
    [0, 0x90, 64, 80],
    [240, 0x80, 64, 0], // E4: 2.5拍〜3拍
  ]);
  const tracks = K.parseMidi(H.smf(0, 480, [trk]));
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].name, 'Melody');
  assert.equal(tracks[0].index, 0);
  const n = tracks[0].notes;
  assert.equal(n.length, 3);
  assert.deepEqual(n.map((x) => x.midi), [60, 62, 64]);
  assert.ok(near(n[0].t, 0) && near(n[0].d, 0.5));
  assert.ok(near(n[1].t, 0.5) && near(n[1].d, 0.5));
  assert.ok(near(n[2].t, 1.25) && near(n[2].d, 0.25));
});

test('parseMidi: format 1, tempo map in conductor track with mid-song change, drums ignored', () => {
  // 96 tpq。0〜4拍: 120BPM(0.5s/拍)、4拍目以降: 60BPM(1.0s/拍)
  const conductor = H.track([
    [0, ...H.trackName('Conductor')],
    [0, ...H.tempo(500000)],
    [0, 0xff, 0x58, 4, 4, 2, 24, 8], // 拍子
    [384, ...H.tempo(1000000)],
  ]);
  const melody = H.track([
    [0, ...H.trackName('Vocal')],
    [0, 0xb0, 7, 100], // control change（2バイト）
    [0, 0xc0, 5], // program change（1バイト）
    [192, 0x90, 67, 100], // 2拍目 = 1.0s
    [192, 0x80, 67, 0], // 4拍目 = 2.0s
    [0, 0x90, 69, 100], // 4拍目 = 2.0s
    [0, 0xe0, 0, 64], // pitch bend
    [96, 69, 0], // ランニングステータスは 0xE0（ピッチベンド）なので、この 69,0 はノートオフではない
  ]);
  const melody2 = H.track([
    [0, ...H.trackName('Vocal')],
    [192, 0x90, 67, 100], // 1.0s
    [192, 0x80, 67, 0], // 2.0s
    [0, 0x90, 69, 100], // 2.0s
    [0, 0xf0, 3, 0x7e, 0x7f, 0xf7], // sysex
    [96, 0x80, 69, 0], // 5拍 = 2.0 + 1.0 = 3.0s
    [96, 0x90, 71, 100], // 6拍 = 4.0s
    [48, 0x90, 71, 0], // 6.5拍 = 4.5s
  ]);
  const drums = H.track([
    [0, ...H.trackName('Drums')],
    [0, 0x99, 36, 100],
    [96, 0x89, 36, 0],
  ]);
  const buf = H.smf(1, 96, [conductor, melody2, drums, melody]);
  const tracks = K.parseMidi(buf);
  // conductor（音符なし）と drums（ch10）は除外
  assert.deepEqual(tracks.map((t) => t.name), ['Vocal', 'Vocal']);
  assert.deepEqual(tracks.map((t) => t.index), [1, 3]);
  const n = tracks[0].notes;
  assert.deepEqual(n.map((x) => x.midi), [67, 69, 71]);
  assert.ok(near(n[0].t, 1.0) && near(n[0].d, 1.0), JSON.stringify(n[0]));
  assert.ok(near(n[1].t, 2.0) && near(n[1].d, 1.0), JSON.stringify(n[1]));
  assert.ok(near(n[2].t, 4.0) && near(n[2].d, 0.5), JSON.stringify(n[2]));
  // 4本目のトラック: 69 は閉じていないので 67 だけ
  assert.deepEqual(tracks[1].notes.map((x) => x.midi), [67]);
});

test('parseMidi: overlapping same-pitch notes are paired FIFO; tempo at tick>0 before first note', () => {
  const trk = H.track([
    [0, 0x90, 60, 100],
    [100, 0x90, 60, 100],
    [100, 0x80, 60, 0], // 1つ目を閉じる @200
    [100, 0x80, 60, 0], // 2つ目を閉じる @300
    [0, ...H.tempo(250000)], // @300 で 240BPM
    [100, 0x90, 72, 100], // @400
    [100, 0x80, 72, 0], // @500
  ]);
  const n = K.parseMidi(H.smf(0, 100, [trk]))[0].notes;
  // 100tpq, 0.5s/拍 → 1tick=5ms; 300tick以降 1tick=2.5ms
  assert.ok(near(n[0].t, 0) && near(n[0].d, 1.0));
  assert.ok(near(n[1].t, 0.5) && near(n[1].d, 1.0));
  assert.ok(near(n[2].t, 1.5 + 0.25) && near(n[2].d, 0.25));
});

test('parseMidi: rejects non-MIDI data', () => {
  assert.throws(() => K.parseMidi(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96]).buffer));
});

test('toMonophonic: chords keep the top note; overlaps resolved', () => {
  const chord = [
    { t: 0, d: 1, midi: 60 }, { t: 0, d: 1, midi: 64 }, { t: 0, d: 1, midi: 67 },
    { t: 1, d: 1, midi: 65 }, { t: 1, d: 1, midi: 69 }, { t: 1, d: 1, midi: 72 },
    { t: 2, d: 0.5, midi: 71 },
  ];
  const m = K.toMonophonic(chord);
  assert.deepEqual(m.map((n) => n.midi), [67, 72, 71]);
  assert.deepEqual(m.map((n) => n.t), [0, 1, 2]);
  // 単旋律の中で重なりがない
  for (let i = 1; i < m.length; i++) assert.ok(m[i - 1].t + m[i - 1].d <= m[i].t + 1e-9);

  // 低い音が上の音より長く伸びる場合、余った部分が後に残る
  const m2 = K.toMonophonic([{ t: 0, d: 2, midi: 55 }, { t: 0, d: 1, midi: 67 }]);
  assert.deepEqual(m2.map((n) => [n.t, n.d, n.midi]), [[0, 1, 67], [1, 1, 55]]);
  // 高い音が後から重なれば、前の音を切る
  const m3 = K.toMonophonic([{ t: 0, d: 1, midi: 60 }, { t: 0.5, d: 1, midi: 72 }]);
  assert.deepEqual(m3.map((n) => [n.t, n.d, n.midi]), [[0, 0.5, 60], [0.5, 1, 72]]);
  // 入力を変更しない
  assert.equal(chord[0].d, 1);
});

/* ================= 5. framesToNotes ================= */
test('framesToNotes: recovers the melody from jittery 60 fps frames with gaps and outliers', () => {
  const melody = [
    { t: 0.5, d: 0.5, midi: 60 }, { t: 1.0, d: 0.5, midi: 62 }, { t: 1.5, d: 1.0, midi: 64 },
    { t: 3.0, d: 0.25, midi: 65 }, { t: 3.25, d: 0.25, midi: 67 }, { t: 3.5, d: 0.75, midi: 67 },
    { t: 4.6, d: 1.2, midi: 72 }, { t: 6.2, d: 0.4, midi: 59 },
  ];
  const r = H.rng(42);
  const frames = [];
  for (let i = 0; i < 7.2 * 60; i++) {
    const t = i / 60;
    const n = melody.find((x) => t >= x.t && t < x.t + x.d - 0.02);
    let midi = n ? n.midi + 0.12 * H.gauss(r) : null;
    if (midi != null && r() < 0.04) midi += (r() < 0.5 ? 12 : -12); // オクターブ誤検出
    if (midi != null && r() < 0.05) midi = null; // 一瞬の途切れ
    frames.push({ t, midi, rms: 0.05 });
  }
  const got = K.framesToNotes(frames);
  // 同じ高さの連続音（67,67）は1つにまとまってよい
  const expect = [60, 62, 64, 65, 67, 72, 59];
  assert.deepEqual(got.map((n) => n.midi), expect, JSON.stringify(got));
  const starts = [0.5, 1.0, 1.5, 3.0, 3.25, 4.6, 6.2];
  got.forEach((n, i) => assert.ok(Math.abs(n.t - starts[i]) < 0.1, `note ${i} t=${n.t}`));
  const g67 = got[4];
  assert.ok(Math.abs(g67.t + g67.d - 4.25) < 0.1);
  assert.ok(Math.abs(got[5].d - 1.2) < 0.1);
});

test('framesToNotes: guide-from-recording round-trip via simulated singer', () => {
  const guide = H.makeMelody(40, 3);
  const frames = H.singFrames(guide, { noise: 0.1, seed: 2 });
  const notes = K.framesToNotes(frames);
  // ほとんどのガイド音符（0.2秒以上）が、正しい高さの音符で覆われている
  // （間隔の短い同じ高さの連続音は1つにまとまるため、開始位置ではなく範囲で判定）
  let found = 0, total = 0;
  for (const g of guide) {
    if (g.d < 0.2) continue;
    total++;
    if (notes.some((n) => n.midi === g.midi && n.t <= g.t + 0.1 && n.t + n.d >= g.t + g.d - 0.1)) found++;
  }
  // 境界は 0.1 秒以内で、余分な音符もほぼない
  assert.ok(notes.length <= guide.length, `${notes.length} > ${guide.length}`);
  assert.ok(found / total > 0.85, `${found}/${total}`);
  assert.deepEqual(K.framesToNotes([]), []);
});

/* ================= helpers ================= */
test('findNote / foldDiff / pitchCredit / clamp', () => {
  const notes = [{ t: 0, d: 1, midi: 60 }, { t: 1, d: 0.5, midi: 62 }, { t: 2, d: 1, midi: 64 }];
  assert.equal(K.findNote(notes, 0), 0);
  assert.equal(K.findNote(notes, 0.999), 0);
  assert.equal(K.findNote(notes, 1), 1);
  assert.equal(K.findNote(notes, 1.7), -1);
  assert.equal(K.findNote(notes, 2.5), 2);
  assert.equal(K.findNote(notes, 3), -1);
  assert.equal(K.findNote(notes, -1), -1);
  assert.equal(K.findNote([], 0), -1);
  assert.ok(near(K.foldDiff(48, 60), 0));
  assert.ok(near(K.foldDiff(72.3, 60), 0.3));
  assert.ok(near(K.foldDiff(59, 60), -1));
  assert.ok(Math.abs(K.foldDiff(66, 60)) === 6);
  assert.equal(K.pitchCredit(0), 1);
  assert.ok(near(K.pitchCredit(0.35), 1));
  assert.ok(near(K.pitchCredit(1.15), 0));
  assert.equal(K.pitchCredit(5), 0);
  assert.ok(K.pitchCredit(0.5) > K.pitchCredit(0.8));
  assert.equal(K.clamp(5, 0, 1), 1);
  assert.equal(K.clamp(-5, 0, 1), 0);
  assert.equal(K.clamp(0.5, 0, 1), 0.5);
});

/* ================= 6. scorePerformance ================= */
const GUIDE = H.makeMelody(90, 7);
const score = (o, guide = GUIDE) => K.scorePerformance(H.singFrames(GUIDE, o), guide, {});
const PROFILES = {
  perfect: { noise: 0.08, vibrato: 0.4 },
  good: { noise: 0.25, wander: 0.25, slide: 1.5, dropout: 0.05, vibrato: 0.3, seed: 3 },
  slight: { noise: 0.2, wander: 0.4, offset: 0.3, seed: 4 },
  poor: { noise: 0.5, wander: 1.0, offset: 0.5, slide: 2, dropout: 0.1, seed: 5 },
  bad: { noise: 0.6, wander: 2.5, offset: 2, seed: 6 },
};

function checkShape(res) {
  for (const k of ['pitch', 'stability', 'expression', 'vibrato', 'longtone']) {
    assert.ok(res.items[k], k);
    assert.equal(typeof res.items[k].label, 'string');
    assert.ok(res.items[k].value >= 0 && res.items[k].value <= 100, `${k}=${res.items[k].value}`);
  }
  assert.ok(Number.isFinite(res.total) && res.total >= 0 && res.total <= 100);
  assert.ok(Array.isArray(res.comments) && res.comments.length > 0);
  assert.ok(Array.isArray(res.notes));
}

test('scorePerformance (guide): ordering perfect > slightly off > poor > bad > silence', () => {
  const r = Object.fromEntries(Object.entries(PROFILES).map(([k, o]) => [k, score(o)]));
  Object.values(r).forEach(checkShape);
  const tot = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.total]));
  assert.ok(tot.perfect > tot.slight && tot.slight > tot.poor && tot.poor > tot.bad, JSON.stringify(tot));
  assert.ok(tot.good > tot.poor);
  assert.ok(tot.perfect >= 90, JSON.stringify(tot));
  assert.ok(tot.good >= 85 && tot.good <= 100, JSON.stringify(tot)); // v0.6: 実際のカラオケ並みに判定を甘くした
  assert.ok(tot.poor >= 55 && tot.poor <= 80, JSON.stringify(tot));
  assert.ok(r.perfect.items.pitch.value > r.slight.items.pitch.value);
  assert.ok(r.slight.items.pitch.value > r.poor.items.pitch.value);
  assert.equal(r.perfect.hasGuide, true);
  assert.ok(r.perfect.items.rhythm.value >= 90, `rhythm ${r.perfect.items.rhythm.value}`);
  assert.ok(Math.abs(r.perfect.timingBias) < 0.04, `bias ${r.perfect.timingBias}`);
  assert.equal(r.perfect.notes.length, GUIDE.length);
  assert.ok(r.perfect.notes.filter((n) => n.hit).length / GUIDE.length > 0.9);
  // 安定性：ビブラートや音の切り替わりで減点しない
  assert.ok(r.perfect.items.stability.value >= 90, `stability ${r.perfect.items.stability.value}`);
  assert.ok(r.perfect.items.vibrato.value > 50);
  assert.ok(r.perfect.items.longtone.value > 50);

  const silent = K.scorePerformance(H.singFrames(GUIDE, { dropout: 1 }), GUIDE, {});
  checkShape(silent);
  assert.equal(silent.total, 0);
  assert.equal(K.scorePerformance([], GUIDE, {}).total, 0);
  assert.equal(K.scorePerformance([], null, {}).total, 0);
});

test('scorePerformance: octave-down/up singing scores like in-tune', () => {
  const base = score(PROFILES.perfect).total;
  const down = score({ ...PROFILES.perfect, octave: -1 }).total;
  const up = score({ ...PROFILES.perfect, octave: 1 }).total;
  assert.ok(Math.abs(down - base) < 1, `${down} vs ${base}`);
  assert.ok(Math.abs(up - base) < 1, `${up} vs ${base}`);
  // 外れた歌は、オクターブを変えても高得点にならない
  assert.ok(score({ ...PROFILES.bad, octave: -1 }).total < base - 20);
});

test('scorePerformance: late / early singing lowers rhythm and reports timing bias', () => {
  const ok = score(PROFILES.perfect);
  const late = score({ ...PROFILES.perfect, lag: 0.25 });
  const early = score({ ...PROFILES.perfect, lag: -0.2 });
  assert.ok(late.items.rhythm.value < ok.items.rhythm.value - 30, `${late.items.rhythm.value} vs ${ok.items.rhythm.value}`);
  assert.ok(late.timingBias > 0.15, `late bias ${late.timingBias}`);
  assert.ok(early.items.rhythm.value < ok.items.rhythm.value - 20, `${early.items.rhythm.value}`);
  assert.ok(early.timingBias < -0.1, `early bias ${early.timingBias}`);
  assert.ok(late.total < ok.total);
  assert.ok(late.comments.some((c) => c.includes('遅れ')));
  assert.ok(early.comments.some((c) => c.includes('走り')));
  const slightlyLate = score({ ...PROFILES.perfect, lag: 0.1 });
  assert.ok(slightlyLate.items.rhythm.value < ok.items.rhythm.value);
  assert.ok(slightlyLate.items.rhythm.value > late.items.rhythm.value);
});

test('scorePerformance: transpose option shifts the guide', () => {
  const sungUp2 = H.singFrames(GUIDE, { ...PROFILES.perfect, offset: 2 });
  const plain = K.scorePerformance(sungUp2, GUIDE, {});
  const trans = K.scorePerformance(sungUp2, GUIDE, { transpose: 2 });
  assert.ok(trans.total > plain.total + 20, `${trans.total} vs ${plain.total}`);
  assert.ok(trans.total > 90);
});

test('scorePerformance (no guide): ordering and range', () => {
  const r = Object.fromEntries(Object.entries(PROFILES).map(([k, o]) => [k, score(o, null)]));
  Object.values(r).forEach(checkShape);
  const tot = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.total]));
  assert.ok(tot.perfect > tot.good && tot.good > tot.slight && tot.slight > tot.poor && tot.poor > tot.bad, JSON.stringify(tot));
  assert.ok(tot.perfect >= 88 && tot.good >= 80 && tot.poor <= 80, JSON.stringify(tot));
  assert.equal(r.perfect.hasGuide, false);
  assert.equal(r.perfect.items.rhythm, undefined);
  assert.equal(r.perfect.key, 'ドメジャー（推定）');
  assert.equal(score({ dropout: 1 }, null).total, 0);
  // 移調しても調の推定は追随する（ハ長調 → ニ長調）
  assert.equal(score({ ...PROFILES.perfect, offset: 2 }, null).key, 'レメジャー（推定）');
});

test('scorePerformance: few voiced seconds gives 0 and a mic comment', () => {
  const frames = [];
  for (let i = 0; i < 600; i++) frames.push({ t: i / 60, midi: i < 100 ? 60 : null, rms: 0.05 });
  const res = K.scorePerformance(frames, null, {});
  assert.equal(res.total, 0);
  assert.ok(res.comments[0].includes('マイク'));
});

test('scorePerformance: a 5-minute song scores in < 500 ms (also a 5-minute sustained tone)', () => {
  const guide = H.makeMelody(300, 9);
  const frames = H.singFrames(guide, { noise: 0.2, wander: 0.2, vibrato: 0.3 });
  assert.ok(frames.length >= 300 * 60 - 120);
  let t0 = process.hrtime.bigint();
  const res = K.scorePerformance(frames, guide, {});
  let ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `guide ${ms.toFixed(0)} ms`);
  assert.ok(res.total > 80);

  t0 = process.hrtime.bigint();
  K.scorePerformance(frames, null, {});
  ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `no guide ${ms.toFixed(0)} ms`);

  // 途切れなく5分間同じ音を伸ばす（以前は O(n²) で数十秒かかった）
  const hum = [];
  for (let i = 0; i < 300 * 60; i++) hum.push({ t: i / 60, midi: 60 + 0.05 * Math.sin(i / 2), rms: 0.05 });
  t0 = process.hrtime.bigint();
  const h = K.scorePerformance(hum, guide, {});
  ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `sustained ${ms.toFixed(0)} ms`);
  assert.equal(h.stats.longCount, 1);
});

test('scorePerformance: does not mutate inputs and accepts unsorted frames', () => {
  const frames = H.singFrames(GUIDE, PROFILES.good);
  const shuffled = frames.slice().reverse();
  const copy = JSON.stringify(shuffled);
  const a = K.scorePerformance(frames, GUIDE, {});
  const b = K.scorePerformance(shuffled, GUIDE, {});
  assert.ok(Math.abs(a.total - b.total) < 1e-9);
  assert.equal(JSON.stringify(shuffled), copy);
});

test('detectMelody: finds a lead melody over chords, bass and noise', () => {
  const sr = 48000, n = 4096;
  const f = (m) => 440 * Math.pow(2, (m - 69) / 12);
  for (const lead of [60, 64, 67, 72, 76]) {
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let s = 0;
      for (const m of [48, 52, 55, 60]) { const ph = 2 * Math.PI * f(m) * t; s += 0.04 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph)); }
      s += 0.15 * Math.sin(2 * Math.PI * f(36) * t);
      const ph = 2 * Math.PI * f(lead) * t;
      s += 0.2 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph));
      buf[i] = s;
    }
    const r = K.detectMelody(buf, sr);
    assert.ok(r.freq > 0, 'voiced for ' + lead);
    assert.ok(Math.abs(K.freqToMidi(r.freq) - lead) < 0.5, `lead ${lead} detected as ${K.freqToMidi(r.freq).toFixed(2)}`);
  }
  assert.equal(K.detectMelody(new Float32Array(n), sr).freq, 0);
});

test('findBarLayout / readBarPitch / estimateBarOffset: reads a synthetic pitch-bar frame', () => {
  const w = 960, h = 250, data = new Uint8ClampedArray(w * h * 4);
  const set = (x, y, c) => { const i = (y * w + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, [70, 70, 75]);
  const top = 10, bottom = 110, step = 4; // 半音4px、五線は8px間隔
  for (let k = 2; k < 25; k += 2) for (let x = 0; x < w; x++) set(x, bottom - k * step, [175, 175, 175]);
  const lineX = 317;
  for (let y = top; y <= bottom; y++) for (let x = lineX - 1; x <= lineX + 1; x++) set(x, y, [255, 90, 170]);
  const barRel = 9; // 帯の下端から9半音
  for (let x = lineX + 2; x < lineX + 80; x++) for (let dy = -2; dy <= 2; dy++) set(x, bottom - barRel * step + dy, [255, 90, 170]);
  const img = { data, width: w, height: h }, rect = { x: 0, y: 0, w, h: 540 };
  const L = K.findBarLayout(img, rect);
  assert.ok(L, 'layout found');
  assert.ok(Math.abs(L.lineLeft - lineX) <= 2 && Math.abs(L.step - step) < 0.3, JSON.stringify(L));
  const r = K.readBarPitch(img, rect, L);
  assert.ok(r && Math.abs(r.rel - barRel) < 0.6, JSON.stringify(r));
  // オフセット推定：rel + 57 = 実音（ノイズ・オクターブ違い混じり）
  const pairs = [];
  for (let i = 0; i < 200; i++) { const rel = (i % 12) + 0.1; let m = rel + 57 + (i % 7 === 0 ? 12 : 0) + Math.sin(i) * 0.2; pairs.push({ rel, midi: m }); }
  const est = K.estimateBarOffset(pairs);
  assert.ok(est && Math.abs(est.offset - 57) < 0.3, JSON.stringify(est));
  assert.equal(K.estimateBarOffset(pairs.slice(0, 5)), null);
});

test('singingSections / maskFrames: drop voice outside sung parts', () => {
  const guide = [{ t: 10, d: 1 }, { t: 11.2, d: 0.5 }, { t: 30, d: 2 }];
  const sec = K.singingSections(guide, null);
  assert.deepEqual(sec.map((v) => v.map((x) => +x.toFixed(2))), [[9.6, 12.2], [29.6, 32.5]]);
  assert.ok(K.inSections(sec, 10.5) && !K.inSections(sec, 20) && !K.inSections(sec, 5));
  const fr = [{ t: 5, midi: 60 }, { t: 10.5, midi: 62 }, { t: 20, midi: 64 }, { t: 31, midi: null }];
  assert.deepEqual(K.maskFrames(fr, sec).map((f) => f.midi), [null, 62, null, null]);
  const ly = K.singingSections(null, [{ t: 15, text: 'あ' }, { t: 18, text: '' }, { t: 40, text: 'い' }]);
  assert.ok(K.inSections(ly, 16) && !K.inSections(ly, 19) && K.inSections(ly, 41));
  assert.equal(K.singingSections(null, null), null);
  assert.equal(K.maskFrames(fr, null), fr);
});

test('scorePerformance: tolerance levels (easy >= normal >= strict)', () => {
  const o = PROFILES.poor;
  const sc = (tol) => K.scorePerformance(H.singFrames(GUIDE, o), GUIDE, { tolerance: tol }).items.pitch.value;
  const e = sc('easy'), n = sc('normal'), st = sc('strict');
  assert.ok(e >= n && n >= st && e > st, JSON.stringify({ e, n, st }));
});

test('judgeChunks: a long bar is judged in parts (partly right is not all right)', () => {
  const guide = [{ t: 1, d: 2, midi: 60 }];
  const fr = [];
  for (let t = 0.9; t < 3.1; t += 1 / 60) fr.push({ t, midi: t < 2 ? 60.1 : 62.5, rms: 0.05 }); // 前半は正しく、後半は2.5半音ずれ
  const ch = K.judgeChunks(fr, guide, K.TOLERANCE.normal);
  assert.ok(ch.length >= 4, 'chunks ' + ch.length);
  const first = ch.filter((c) => c.t1 <= 2), second = ch.filter((c) => c.t0 >= 2.05);
  assert.ok(first.every((c) => c.hit), JSON.stringify(first));
  assert.ok(second.every((c) => !c.hit && Math.abs(c.sung - 62.5) < 0.2), JSON.stringify(second));
  const r = K.scorePerformance(fr, guide, {});
  assert.ok(r.items.pitch.value > 35 && r.items.pitch.value < 65, 'pitch ' + r.items.pitch.value);
  // 歌唱中の表示用：until より後に終わる区切りは返さない
  assert.ok(K.judgeChunks(fr, guide, null, { until: 1.6 }).every((c) => c.t1 <= 1.6));
});
