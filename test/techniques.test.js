'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../core.js');
const H = require('./helpers.js');

/*
 * 60fps の歌唱フレームを合成する。
 * phrases: [{ notes: [{midi, d, shakuri?, kobushi?, vib?}], fall? }] — フレーズ間は 0.6 秒の息継ぎ
 *  shakuri: 下から上がる幅（半音、0.15秒で到達）, kobushi: 音の途中で跳ねる高さ（0.16秒）
 *  vib: ビブラート振幅（半音、5.5Hz、音の後半）, fall: フレーズ最後の音で下がる幅（0.25秒）
 */
function synth(phrases, o = {}) {
  const r = H.rng(o.seed || 21);
  const fps = 60, frames = [];
  let t = 0.5;
  const push = (m) => {
    let midi = m + (o.jitter == null ? 0.12 : o.jitter) * H.gauss(r);
    if (o.glitch && r() < o.glitch) midi += r() < 0.5 ? -12 : 12;
    if (o.dropout && r() < o.dropout) midi = null;
    frames.push({ t, midi, rms: 0.05 });
    t += 1 / fps;
  };
  const silence = (sec) => { for (let k = 0; k < sec * fps; k++) { frames.push({ t, midi: null, rms: 0.002 }); t += 1 / fps; } };
  silence(0.5);
  for (const ph of phrases) {
    ph.notes.forEach((n, ni) => {
      const N = Math.round(n.d * fps);
      for (let k = 0; k < N; k++) {
        const x = k / fps;
        let m = n.midi;
        if (n.shakuri && x < 0.15) m -= n.shakuri * (1 - x / 0.15);
        if (n.kobushi) {
          const c = n.d * 0.5;
          if (Math.abs(x - c) < 0.08) m += n.kobushi * Math.sin(Math.PI * (x - c + 0.08) / 0.16);
        }
        if (n.vib && x > n.d * 0.35) m += n.vib * Math.sin(2 * Math.PI * 5.5 * (x - n.d * 0.35));
        push(m);
      }
      if (ni === ph.notes.length - 1 && ph.fall) {
        const F = Math.round(0.25 * fps);
        for (let k = 1; k <= F; k++) push(n.midi - ph.fall * Math.pow(k / F, 1.5));
      }
    });
    silence(0.6);
  }
  return frames;
}
const sumCounts = (c, keys) => keys.reduce((a, k) => a + c[k], 0);
const near = (got, want, tol, label) => assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ${want}±${tol}`);

test('detectTechniques: API shape and empty input', () => {
  const r = K.detectTechniques([]);
  for (const k of ['shakuri', 'kobushi', 'fall', 'vibrato']) {
    assert.ok(Array.isArray(r[k]));
    assert.equal(r.counts[k], 0);
  }
  assert.deepEqual(K.detectTechniques(null).counts, { shakuri: 0, kobushi: 0, fall: 0, vibrato: 0 });
});

test('detectTechniques: しゃくり at phrase starts and inside connected phrases', () => {
  const phrases = [];
  for (let i = 0; i < 8; i++) {
    phrases.push({ notes: [
      { midi: 64, d: 0.6, shakuri: i % 2 ? 0 : 1.5 },          // フレーズ頭（4回）
      { midi: 67, d: 0.6, shakuri: i % 2 ? 4 : 0 },            // 途中で下から（67 を 63 から、4回）
      { midi: 65, d: 0.7 },
    ] });
  }
  for (const seed of [1, 2, 3]) {
    const r = K.detectTechniques(synth(phrases, { seed }));
    near(r.counts.shakuri, 8, 1, `seed ${seed} shakuri`);
    assert.ok(r.counts.kobushi + r.counts.fall <= 1, JSON.stringify(r.counts));
  }
  // 時刻は音の出だし付近
  const r = K.detectTechniques(synth(phrases));
  assert.ok(r.shakuri.every((e) => Number.isFinite(e.t)));
});

test('detectTechniques: こぶし on held notes', () => {
  const phrases = [];
  for (let i = 0; i < 6; i++) phrases.push({ notes: [{ midi: 62, d: 0.5 }, { midi: 64, d: 1.0, kobushi: 1.2 }, { midi: 62, d: 0.6 }] });
  for (const seed of [1, 2, 3]) {
    const r = K.detectTechniques(synth(phrases, { seed }));
    near(r.counts.kobushi, 6, 1, `seed ${seed} kobushi`);
    assert.ok(r.counts.shakuri + r.counts.fall <= 1, JSON.stringify(r.counts));
  }
});

test('detectTechniques: フォール at the end of held notes', () => {
  const phrases = [];
  for (let i = 0; i < 6; i++) phrases.push({ notes: [{ midi: 60, d: 0.5 }, { midi: 62, d: 0.8 }], fall: i % 2 ? 3 : 2 });
  // 普通に終わるフレーズ（フォールなし）
  for (let i = 0; i < 4; i++) phrases.push({ notes: [{ midi: 60, d: 0.5 }, { midi: 62, d: 0.8 }] });
  for (const seed of [1, 2, 3]) {
    const r = K.detectTechniques(synth(phrases, { seed }));
    near(r.counts.fall, 6, 1, `seed ${seed} fall`);
    assert.ok(r.counts.shakuri + r.counts.kobushi <= 1, JSON.stringify(r.counts));
  }
});

test('detectTechniques: ビブラート occurrences with duration, no こぶし', () => {
  const phrases = [];
  for (let i = 0; i < 5; i++) phrases.push({ notes: [{ midi: 60, d: 0.4 }, { midi: 64, d: 2.0, vib: i % 2 ? 0.8 : 0.4 }] });
  for (const seed of [1, 2]) {
    const r = K.detectTechniques(synth(phrases, { seed }));
    near(r.counts.vibrato, 5, 1, `seed ${seed} vibrato`);
    assert.ok(r.vibrato.every((v) => v.d >= 0.45 && v.d <= 1.5), JSON.stringify(r.vibrato));
    assert.equal(r.counts.kobushi, 0, JSON.stringify(r.counts));
    assert.ok(r.counts.fall === 0 && r.counts.shakuri <= 1, JSON.stringify(r.counts));
  }
});

test('detectTechniques: plain stepwise melody has ~no しゃくり/こぶし/フォール', () => {
  const guide = H.makeMelody(90, 7);
  for (const seed of [11, 12]) {
    const r = K.detectTechniques(H.singFrames(guide, { noise: 0.15, seed }));
    assert.ok(sumCounts(r.counts, ['shakuri', 'kobushi', 'fall']) <= 2, JSON.stringify(r.counts));
    assert.ok(r.counts.vibrato <= 3, JSON.stringify(r.counts)); // ゆらぎをビブラートと誤認しない
  }
});

test('detectTechniques: octave glitches and dropouts do not create techniques', () => {
  const phrases = [];
  for (let i = 0; i < 6; i++) phrases.push({ notes: [{ midi: 60, d: 0.6 }, { midi: 62, d: 0.6 }, { midi: 64, d: 0.9 }] });
  const r = K.detectTechniques(synth(phrases, { glitch: 0.02, dropout: 0.03, seed: 5 }));
  assert.ok(sumCounts(r.counts, ['shakuri', 'kobushi', 'fall']) <= 1, JSON.stringify(r.counts));
  // 装飾ありでも、グリッチがあって検出できる
  const orn = [];
  for (let i = 0; i < 6; i++) orn.push({ notes: [{ midi: 60, d: 0.6, shakuri: 1.5 }, { midi: 64, d: 1.0, kobushi: 1.2 }], fall: 3 });
  const g = K.detectTechniques(synth(orn, { glitch: 0.02, dropout: 0.03, seed: 6 }));
  near(g.counts.shakuri, 6, 1, 'shakuri');
  near(g.counts.kobushi, 6, 1, 'kobushi');
  near(g.counts.fall, 6, 1, 'fall');
});

test('detectTechniques: works with uneven high frame rate (~165 fps rAF)', () => {
  const orn = [];
  for (let i = 0; i < 6; i++) orn.push({ notes: [{ midi: 60, d: 0.6, shakuri: 1.5 }, { midi: 64, d: 1.0, kobushi: 1.2 }], fall: 3 });
  const base = synth(orn, { seed: 8 });
  // 60fps の軌跡を 165fps 前後に補間し直す
  const r = H.rng(3), hi = [];
  for (let t = base[0].t, j = 0; t < base[base.length - 1].t; t += 0.006 + 0.001 * r()) {
    while (j + 1 < base.length && base[j + 1].t <= t) j++;
    const f = base[j];
    hi.push({ t, midi: f.midi == null ? null : f.midi + 0.05 * H.gauss(r), rms: f.rms });
  }
  const c = K.detectTechniques(hi).counts;
  near(c.shakuri, 6, 1, 'shakuri');
  near(c.kobushi, 6, 1, 'kobushi');
  near(c.fall, 6, 1, 'fall');
});

test('detectTechniques: a 4-minute performance runs in < 300 ms with plausible counts', () => {
  const guide = H.makeMelody(240, 13);
  const frames = H.singFrames(guide, { noise: 0.2, wander: 0.2, vibrato: 0.4, slide: 1.5, dropout: 0.03, seed: 9 });
  K.detectTechniques(frames.slice(0, 600)); // ウォームアップ
  const t0 = process.hrtime.bigint();
  const r = K.detectTechniques(frames);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 300, `${ms.toFixed(0)} ms`);
  assert.ok(r.counts.kobushi < 20, JSON.stringify(r.counts));
  assert.ok(r.counts.shakuri <= guide.length, JSON.stringify(r.counts));
  assert.ok(r.counts.vibrato > 5, JSON.stringify(r.counts));
});

test('scorePerformance: techniques, bonus and cap at 100', () => {
  const guide = H.makeMelody(90, 7);
  const frames = H.singFrames(guide, { noise: 0.08, vibrato: 0.4, slide: 1.5 });
  const res = K.scorePerformance(frames, guide, {});
  assert.ok(res.techniques && res.techniques.counts && res.techniques.events);
  for (const k of ['shakuri', 'kobushi', 'fall', 'vibrato']) {
    assert.equal(res.techniques.counts[k], res.techniques.events[k].length);
  }
  assert.ok(res.techniques.counts.vibrato > 0);
  // ビブラートの合計時間は vibratoSec とそろう
  const vsum = res.techniques.events.vibrato.reduce((a, v) => a + v.d, 0);
  assert.ok(Math.abs(vsum - res.stats.vibratoSec) <= 0.05 * res.stats.vibratoSec + 0.1, `${vsum} vs ${res.stats.vibratoSec}`);
  assert.ok(res.bonus > 0 && res.bonus <= 3, `bonus ${res.bonus}`);
  const base = 100 * Math.pow(res.raw / 100, 0.6);
  assert.ok(Math.abs(res.total - Math.min(100, base + res.bonus)) < 1e-9);
  assert.ok(res.total > base || res.total === 100);
  assert.ok(res.total <= 100);
  // ボーナスは回数に応じて逓減し、上限3点
  assert.equal(K.techniqueBonus({ shakuri: 0, kobushi: 0, fall: 0, vibrato: 0 }), 0);
  const many = K.techniqueBonus({ shakuri: 1000, kobushi: 1000, fall: 1000, vibrato: 1000 });
  assert.ok(many <= 3 && many > 2.9, `${many}`);
  assert.ok(K.techniqueBonus({ vibrato: 1 }) > K.techniqueBonus({ shakuri: 1 }));
  assert.ok(K.techniqueBonus({ kobushi: 1 }) > K.techniqueBonus({ fall: 1 }));
  assert.ok(K.techniqueBonus({ shakuri: 2 }) - K.techniqueBonus({ shakuri: 1 }) < K.techniqueBonus({ shakuri: 1 }));
  // ほぼ満点の歌 + テクニックでも 100 を超えない
  const top = K.scorePerformance(H.singFrames(guide, { noise: 0.02, vibrato: 0.5, slide: 1.5 }), guide, {});
  assert.ok(top.total <= 100 && top.total >= 95, `${top.total}`);
  // 歌声が少ないときはボーナスなしで 0 点
  const few = [];
  for (let i = 0; i < 600; i++) few.push({ t: i / 60, midi: i < 100 ? 60 + (i < 8 ? -1.5 + i * 0.19 : 0) : null, rms: 0.05 });
  const f = K.scorePerformance(few, null, {});
  assert.equal(f.total, 0);
  assert.equal(f.bonus, 0);
});

test('scorePerformance: technique comments', () => {
  const guide = H.makeMelody(60, 7);
  const plain = K.scorePerformance(H.singFrames(guide, { noise: 0.1 }), guide, {});
  if (plain.techniques.counts.shakuri + plain.techniques.counts.kobushi + plain.techniques.counts.fall === 0) {
    assert.ok(plain.comments.some((c) => c.includes('テクニック')), JSON.stringify(plain.comments));
  }
  const orn = [];
  for (let i = 0; i < 12; i++) orn.push({ notes: [{ midi: 60, d: 0.6, shakuri: 1.5 }, { midi: 64, d: 2.0, kobushi: 1.2, vib: 0.5 }], fall: 3 });
  const rich = K.scorePerformance(synth(orn), null, {});
  assert.ok(rich.comments.some((c) => c.includes('テクニックを豊富に')), JSON.stringify([rich.techniques.counts, rich.comments]));
});
