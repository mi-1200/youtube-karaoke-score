'use strict';
/* 点数アップのアドバイス（adviceSummary / estimateGain / localAdvice / buildAdvicePrompt） */
const test = require('node:test');
const assert = require('node:assert');
const K = require('../core.js');
const H = require('./helpers.js');

const GUIDE = H.makeMelody(90, 7);
const run = (o) => K.scorePerformance(H.singFrames(GUIDE, o), GUIDE, {});

test('estimateGain: 上げた分だけ合計が上がり、満点の項目は0', () => {
  const res = run({ noise: 0.25, wander: 0.5, seed: 5 });
  const g = K.estimateGain(res, 'pitch', 15);
  assert.ok(g > 0, 'pitch gain ' + g);
  assert.ok(g > K.estimateGain(res, 'longtone', 15), '音程(重み0.6)はロングトーン(0.05)より効く');
  assert.equal(K.estimateGain(res, 'nope', 15), 0);
  const fake = Object.assign({}, res, { items: Object.assign({}, res.items, { pitch: { label: '音程', value: 100 } }) });
  assert.equal(K.estimateGain(fake, 'pitch', 15), 0);
  assert.equal(K.estimateGain(K.scorePerformance([], GUIDE, {}), 'pitch', 15), 0);
});

test('adviceSummary: 集計だけで、音声・曲名・フレームを含まない', () => {
  const res = run({ noise: 0.2, offset: -0.9, seed: 4 });
  const s = K.adviceSummary(res, { tolerance: 'normal' });
  assert.equal(s.mode, 'ガイドメロディ採点');
  assert.ok(s.items.pitch && typeof s.items.pitch.value === 'number');
  assert.ok(s.barsTotal > 0 && s.barsHit <= s.barsTotal);
  assert.ok(s.meanDevSemitone < -0.5, '低めに歌うとマイナス: ' + s.meanDevSemitone);
  assert.ok(s.flatPct > s.sharpPct);
  assert.ok(s.byRange && s.byRange.low && s.byRange.high);
  assert.ok(Array.isArray(s.weakSections) && s.weakSections.length <= 3);
  assert.match(s.weakSections[0].from, /^\d+:\d\d$/);
  const json = JSON.stringify(s);
  assert.ok(json.length < 3000, 'size ' + json.length);
  for (const k of ['frames', 'notes', 'chunks', 'title', 'videoId', 'lyrics']) assert.ok(!(k in s), k);
});

test('localAdvice: 伸びしろの大きい順、低めに歌うと音程が先頭でフラットと言う', () => {
  const res = run({ noise: 0.2, offset: -0.9, seed: 4 });
  const adv = K.localAdvice(res);
  assert.ok(adv.length >= 1 && adv.length <= 4);
  assert.equal(adv[0].key, 'pitch');
  assert.match(adv[0].detail, /フラット|低め/);
  for (let i = 1; i < adv.length; i++) assert.ok(adv[i - 1].gain >= adv[i].gain);
});

test('localAdvice: 歌っていない所が多いと参加のアドバイス、無音ならマイク確認', () => {
  const res = run({ noise: 0.1, dropout: 0.7, seed: 2 });
  assert.ok(K.localAdvice(res).some((a) => a.key === 'participation'));
  const silent = K.localAdvice(K.scorePerformance([], GUIDE, {}));
  assert.equal(silent[0].key, 'mic');
});

test('localAdvice: ガイドなしでも動く', () => {
  const res = K.scorePerformance(H.singFrames(GUIDE, { noise: 0.5, seed: 9 }), null, {});
  const adv = K.localAdvice(res);
  assert.ok(adv.length >= 1);
  assert.ok(!('barsTotal' in K.adviceSummary(res)));
});

test('buildAdvicePrompt: 採点の仕組みと集計JSONを渡す', () => {
  const s = K.adviceSummary(run({ noise: 0.2, seed: 3 }));
  const p = K.buildAdvicePrompt(s);
  assert.match(p.system, /音程0\.6/);
  assert.ok(p.user.includes(JSON.stringify(s)));
});
