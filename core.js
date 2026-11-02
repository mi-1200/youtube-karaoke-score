/* カラオケ採点のコアロジック（DOMに依存しない純粋関数） */
(function (root) {
  'use strict';

  const NOTE_NAMES = ['ド', 'ド#', 'レ', 'レ#', 'ミ', 'ファ', 'ファ#', 'ソ', 'ソ#', 'ラ', 'ラ#', 'シ'];
  const NOTE_NAMES_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function midiName(m, en) {
    const r = Math.round(m);
    const names = en ? NOTE_NAMES_EN : NOTE_NAMES;
    return names[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  }

  /* ---------- YouTube ---------- */
  function parseVideoId(input) {
    if (!input) return null;
    const s = String(input).trim();
    const ID = /^[A-Za-z0-9_-]{11}$/;
    if (ID.test(s)) return s;
    try {
      // スキーム省略（youtube.com/watch?v=...）にも対応
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
      const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
      if (host === 'youtu.be') {
        const id = u.pathname.split('/')[1] || '';
        return ID.test(id) ? id : null;
      }
      if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        const v = (u.searchParams.get('v') || '').slice(0, 11);
        if (ID.test(v)) return v;
        const m = u.pathname.match(/^\/(embed|shorts|live|v|e)\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
        if (m) return m[2];
      }
      return null;
    } catch (e) { /* not a URL */ }
    return null;
  }

  /* ---------- ピッチ検出（YIN） ---------- */
  // buf: Float32Array（時間領域）。戻り値 {freq, clarity, rms}。無声なら freq=0
  function detectPitch(buf, sampleRate, opts) {
    opts = opts || {};
    const minF = opts.minFreq || 70, maxF = opts.maxFreq || 1200;
    const threshold = opts.threshold || 0.15;
    const rmsGate = opts.rmsGate == null ? 0.01 : opts.rmsGate;
    const n = buf.length;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < rmsGate) return { freq: 0, clarity: 0, rms };

    const W = Math.floor(n / 2);
    const minTau = Math.max(2, Math.floor(sampleRate / maxF));
    const maxTau = Math.min(W - 1, Math.ceil(sampleRate / minF));
    const d = new Float32Array(maxTau + 2);
    for (let tau = 1; tau <= maxTau + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const x = buf[j] - buf[j + tau]; s += x * x; }
      d[tau] = s;
    }
    // 累積平均正規化差分関数
    const c = new Float32Array(maxTau + 2);
    c[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= maxTau + 1; tau++) {
      run += d[tau];
      c[tau] = run > 0 ? d[tau] * tau / run : 1;
    }
    let tauEst = -1;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (c[tau] < threshold) {
        while (tau + 1 <= maxTau && c[tau + 1] < c[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) return { freq: 0, clarity: 0, rms };
    // 放物線補間
    let better = tauEst;
    const x0 = c[tauEst - 1], x1 = c[tauEst], x2 = c[tauEst + 1];
    const den = x0 + x2 - 2 * x1;
    if (den !== 0) better = tauEst + (x0 - x2) / (2 * den);
    return { freq: sampleRate / better, clarity: 1 - x1, rms };
  }

  /* ---------- 歌詞（LRC形式） ---------- */
  function parseLrc(text) {
    const lines = [];
    String(text || '').split(/\r?\n/).forEach((raw) => {
      const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
      const stamps = [];
      let m, last = 0;
      while ((m = re.exec(raw))) { stamps.push(parseInt(m[1], 10) * 60 + parseFloat(m[2])); last = re.lastIndex; }
      if (!stamps.length) return;
      const body = raw.slice(last).trim();
      stamps.forEach((t) => lines.push({ t, text: body }));
    });
    lines.sort((a, b) => a.t - b.t);
    return lines;
  }
  function formatStamp(t) {
    // 先に1/100秒へ丸める（59.999秒が [00:60.00] にならないように）
    const cs = Math.round(Math.max(0, Number(t) || 0) * 100);
    const m = Math.floor(cs / 6000), s = (cs - m * 6000) / 100;
    return '[' + String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0') + ']';
  }

  /* ---------- MIDI 読み込み ---------- */
  function parseMidi(arrayBuffer) {
    const v = new DataView(arrayBuffer);
    let p = 0;
    const str = (len) => { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(p + i)); p += len; return s; };
    const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
    const u16 = () => { const x = v.getUint16(p); p += 2; return x; };
    const u8 = () => v.getUint8(p++);
    const vlq = () => { let x = 0, b; do { b = u8(); x = (x << 7) | (b & 0x7f); } while (b & 0x80); return x; };

    if (str(4) !== 'MThd') throw new Error('MIDIファイルではありません');
    const hlen = u32();
    u16(); // format
    const ntrk = u16();
    const division = u16();
    p += hlen - 6;
    if (division & 0x8000) throw new Error('SMPTE形式のMIDIには未対応です');

    const tempos = [{ tick: 0, uspq: 500000 }];
    const rawTracks = [];
    for (let t = 0; t < ntrk && p < v.byteLength; t++) {
      const id = str(4), len = u32(), end = p + len;
      if (id !== 'MTrk') { p = end; continue; }
      let tick = 0, status = 0, name = '';
      const on = {}, notes = [];
      while (p < end) {
        tick += vlq();
        let b = v.getUint8(p);
        if (b & 0x80) { status = b; p++; } else if (status < 0x80) { break; }
        const type = status & 0xf0, ch = status & 0x0f;
        if (status === 0xff) {
          const mt = u8(), ml = vlq();
          if (mt === 0x51 && ml === 3) tempos.push({ tick, uspq: (v.getUint8(p) << 16) | (v.getUint8(p + 1) << 8) | v.getUint8(p + 2) });
          if (mt === 0x03) { const save = p; name = ''; for (let i = 0; i < ml; i++) name += String.fromCharCode(v.getUint8(save + i)); }
          p += ml;
          status = 0;
        } else if (status === 0xf0 || status === 0xf7) {
          const sl = vlq(); p += sl; status = 0; // 注意: "p += vlq()" だと長さバイト分の前進が失われる
        } else if (type === 0x90 || type === 0x80) {
          const note = u8(), vel = u8();
          const key = ch * 128 + note;
          if (type === 0x90 && vel > 0) {
            (on[key] = on[key] || []).push({ tick, vel });
          } else if (on[key] && on[key].length) {
            const st = on[key].shift();
            notes.push({ ch, midi: note, startTick: st.tick, endTick: tick, vel: st.vel });
          }
        } else if (type === 0xc0 || type === 0xd0) { p += 1; }
        else { p += 2; }
      }
      p = end;
      rawTracks.push({ name, notes });
    }
    tempos.sort((a, b) => a.tick - b.tick);
    const tickToSec = (tick) => {
      let sec = 0, lastTick = 0, uspq = 500000;
      for (const tp of tempos) {
        if (tp.tick >= tick) break;
        sec += (tp.tick - lastTick) * uspq / 1e6 / division;
        lastTick = tp.tick; uspq = tp.uspq;
      }
      return sec + (tick - lastTick) * uspq / 1e6 / division;
    };
    return rawTracks
      .map((tr, i) => {
        const notes = tr.notes.filter((n) => n.ch !== 9).map((n) => {
          const t = tickToSec(n.startTick);
          return { t, d: Math.max(0.03, tickToSec(n.endTick) - t), midi: n.midi };
        }).sort((a, b) => a.t - b.t);
        return { index: i, name: tr.name || ('トラック' + (i + 1)), notes };
      })
      .filter((tr) => tr.notes.length > 0);
  }

  // 和音を最高音だけの単旋律にする
  function toMonophonic(notes) {
    const src = notes.slice().sort((a, b) => a.t - b.t || b.midi - a.midi);
    const out = [];
    for (const n of src) {
      const cur = { t: n.t, d: n.d, midi: n.midi };
      const prev = out[out.length - 1];
      if (prev && prev.t + prev.d > cur.t + 1e-6) {
        if (cur.midi >= prev.midi) {
          prev.d = cur.t - prev.t;
          if (prev.d < 0.05) out.pop();
        } else {
          const e = cur.t + cur.d, ps = prev.t + prev.d;
          if (e - ps < 0.08) continue;
          cur.t = ps; cur.d = e - ps;
        }
      }
      out.push(cur);
    }
    return out;
  }

  /* ---------- お手本の録音フレーム → 音符 ---------- */
  function median(arr) { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; }

  function framesToNotes(frames, opts) {
    opts = opts || {};
    const minDur = opts.minDur || 0.12, maxGap = opts.maxGap || 0.09;
    const fr = frames.filter((f) => f.midi != null).sort((a, b) => a.t - b.t);
    // 5点メディアンで外れ値除去
    const sm = fr.map((f, i) => {
      const w = [];
      for (let k = i - 2; k <= i + 2; k++) if (fr[k] && Math.abs(fr[k].t - f.t) < 0.1) w.push(fr[k].midi);
      return { t: f.t, midi: median(w) };
    });
    const notes = [];
    let cur = null, pending = 0;
    const close = () => {
      if (cur && cur.end - cur.t >= minDur) notes.push({ t: cur.t, d: cur.end - cur.t, midi: Math.round(median(cur.vals)) });
      cur = null;
    };
    for (const f of sm) {
      if (cur && f.t - cur.end > maxGap) close();
      if (!cur) { cur = { t: f.t, end: f.t, vals: [f.midi] }; pending = 0; continue; }
      const ref = median(cur.vals.slice(-8));
      if (Math.abs(f.midi - ref) > 0.6) {
        pending++;
        if (pending >= 3) { close(); cur = { t: f.t, end: f.t, vals: [f.midi] }; pending = 0; }
        continue;
      }
      pending = 0;
      cur.vals.push(f.midi);
      cur.end = f.t;
    }
    close();
    // 隣接する同じ高さの音を結合
    const merged = [];
    for (const n of notes) {
      const pr = merged[merged.length - 1];
      if (pr && pr.midi === n.midi && n.t - (pr.t + pr.d) < 0.12) pr.d = n.t + n.d - pr.t;
      else merged.push({ ...n });
    }
    return merged;
  }

  /* ---------- 採点 ---------- */
  function findNote(notes, t) {
    let lo = 0, hi = notes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, n = notes[mid];
      if (t < n.t) hi = mid - 1;
      else if (t >= n.t + n.d) lo = mid + 1;
      else return mid;
    }
    return -1;
  }
  // オクターブ違いを許容した半音差
  function foldDiff(sung, target) { const d = sung - target; return d - 12 * Math.round(d / 12); }
  function pitchCredit(absDiff) { return clamp(1 - (absDiff - 0.35) / 0.8, 0, 1); }

  // 連続した有声区間（ラン）
  function voicedRuns(voiced) {
    const runs = [];
    let run = [];
    for (const f of voiced) {
      if (run.length && f.t - run[run.length - 1].t > 0.08) { runs.push(run); run = []; }
      run.push(f);
    }
    if (run.length) runs.push(run);
    return runs;
  }
  // 局所中央値（前後7フレーム）からのずれ。安定度とビブラート判定に使う
  function detrendRuns(runs) {
    const detrended = [];
    for (const r of runs) {
      if (r.length < 6) continue;
      const det = [];
      // 前後約0.12秒（フレームレートに依存しないよう時間で区切る）
      let lo = 0, hi = 0;
      for (let i = 0; i < r.length; i++) {
        while (r[lo].t < r[i].t - 0.12) lo++;
        while (hi + 1 < r.length && r[hi + 1].t <= r[i].t + 0.12) hi++;
        const w = [];
        for (let k = lo; k <= hi; k++) w.push(r[k].midi);
        const dev = r[i].midi - median(w);
        det.push({ t: r[i].t, dev, midi: r[i].midi, vib: false });
      }
      detrended.push(det);
    }
    return detrended;
  }
  // ビブラート：0.5秒窓で 4〜8.5Hz、振幅 0.15〜1.3半音の揺れ。該当窓の det[k].vib を立てる
  // 周期性：1周期ずらした自己相関が高い（ゆらぎ・ノイズをビブラートと誤認しない）
  function periodic(det, i, j, lag) {
    let best = -1;
    for (let L = Math.max(2, Math.floor(lag) - 1); L <= Math.ceil(lag) + 1; L++) {
      let sxy = 0, sxx = 0, syy = 0;
      for (let k = i; k + L < j; k++) { const x = det[k].dev, y = det[k + L].dev; sxy += x * y; sxx += x * x; syy += y * y; }
      if (sxx > 0 && syy > 0) best = Math.max(best, sxy / Math.sqrt(sxx * syy));
    }
    return best >= VIB_PERIODIC;
  }
  const VIB_PERIODIC = 0.5; // -Infinity で周期性チェックなし
  function scanVibrato(detrended) {
    let sec = 0;
    const windows = [];
    for (const det of detrended) {
      for (let i = 0; i < det.length;) {
        const t0 = det[i].t;
        let j = i, cross = 0, mx = -1e9, mn = 1e9;
        while (j < det.length && det[j].t - t0 < 0.5) {
          if (j > i && (det[j].dev > 0) !== (det[j - 1].dev > 0)) cross++;
          mx = Math.max(mx, det[j].dev); mn = Math.min(mn, det[j].dev);
          j++;
        }
        const span = det[j - 1].t - t0;
        if (span > 0.4) {
          const rate = cross / 2 / span, amp = (mx - mn) / 2;
          if (rate >= 4 && rate <= 8.5 && amp >= 0.15 && amp <= 1.3 && periodic(det, i, j, (j - i - 1) / span / rate)) {
            sec += span;
            windows.push({ t0, t1: det[j - 1].t });
            for (let k = i; k < j; k++) det[k].vib = true;
          }
        }
        i = j;
      }
    }
    return { sec, windows };
  }

  /* ---------- 歌唱テクニック（しゃくり・こぶし・フォール・ビブラート） ---------- */
  // 判定のしきい値（DAMなどの採点機の感覚に合わせた値）
  const TECH = {
    fps: 60,              // 内部で 60fps の格子に揃えてから判定する
    bridge: 0.07,         // これ以下の途切れはつなぐ（秒）
    stableWin: 0.15,      // 「音が落ち着いた」とみなす長さ（秒）
    stableRange: 0.8,     // その間の上下幅（半音）
    shakuriRise: 0.9,     // しゃくり：下から上がる幅（半音）
    shakuriMin: 0.05, shakuriMax: 0.3, shakuriLook: 0.4,
    kobushiRise: 0.7,     // こぶし：保っている音から上に跳ねる幅（半音）
    kobushiMin: 0.06, kobushiMax: 0.3, kobushiTop: 0.15,
    fallDrop: 1.5,        // フォール：音の終わりで下がる幅（半音）
    fallHold: 0.2, fallMin: 0.07, fallMax: 0.45,
    vibMerge: 0.1,        // ビブラート窓をつなぐ間隔（秒）
  };
  function median3(a, b, c) { return a > b ? (b > c ? b : (a > c ? c : a)) : (a > c ? a : (b > c ? c : b)); }
  // 窓 [lo, hi] の中央値（小さな窓用）
  function medianRange(p, lo, hi) {
    const w = [];
    for (let k = lo; k <= hi; k++) w.push(p[k]);
    w.sort((x, y) => x - y);
    return w.length ? w[w.length >> 1] : 0;
  }

  // frames: [{t, midi|null, rms}] → { shakuri:[{t}], kobushi:[{t}], fall:[{t}], vibrato:[{t,d}], counts }
  // opts.vibrato: scanVibrato の結果（scorePerformance から渡すと再計算しない）
  function detectTechniques(frames, opts) {
    opts = opts || {};
    const P = Object.assign({}, TECH, opts.params || {});
    const out = { shakuri: [], kobushi: [], fall: [], vibrato: [], counts: { shakuri: 0, kobushi: 0, fall: 0, vibrato: 0 } };
    const fr = (frames || []).filter((f) => f && Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
    const voiced = fr.filter((f) => f.midi != null && Number.isFinite(f.midi));

    // ビブラート：scorePerformance と同じ判定（vibratoSec と一致させる）
    const vib = opts.vibrato || scanVibrato(detrendRuns(voicedRuns(voiced)));
    for (const w of vib.windows) {
      const pr = out.vibrato[out.vibrato.length - 1];
      if (pr && w.t0 - (pr.t + pr.d) <= P.vibMerge) pr.d = Math.max(pr.d, w.t1 - pr.t);
      else out.vibrato.push({ t: w.t0, d: w.t1 - w.t0 });
    }

    if (voiced.length >= 6) {
      // 1) 60fps の格子に揃える（ビン内は中央値）
      const dt = 1 / P.fps, t0 = voiced[0].t;
      const n = Math.floor((voiced[voiced.length - 1].t - t0) / dt) + 1;
      const raw = new Array(n).fill(null);
      for (let i = 0; i < voiced.length;) {
        const b = Math.min(n - 1, Math.round((voiced[i].t - t0) / dt));
        let j = i;
        const w = [];
        while (j < voiced.length && Math.min(n - 1, Math.round((voiced[j].t - t0) / dt)) === b) w.push(voiced[j++].midi);
        w.sort((x, y) => x - y);
        raw[b] = w[w.length >> 1];
        i = j;
      }
      // 2) 短い途切れをつなぐ（前後の高さが近いときだけ）
      const maxGap = Math.round(P.bridge / dt);
      for (let i = 1; i < n; i++) {
        if (raw[i] != null || raw[i - 1] == null) continue;
        let j = i;
        while (j < n && raw[j] == null) j++;
        if (j < n && j - i <= maxGap) {
          const a = raw[i - 1], c = raw[j], d = c - a, df = d - 12 * Math.round(d / 12);
          if (Math.abs(df) < 2) for (let k = i; k < j; k++) raw[k] = 2 * (k - i) < j - i ? a : a + df; // 補間で「滑り」を作らない
        }
        i = j;
      }
      // ラン（連続区間）
      const runs = [];
      for (let i = 0; i < n;) {
        if (raw[i] == null) { i++; continue; }
        let j = i;
        while (j + 1 < n && raw[j + 1] != null) j++;
        if (j - i >= 5) runs.push([i, j]);
        i = j + 1;
      }
      const p = new Float64Array(n), L = new Float64Array(n), M = new Float64Array(n); // M: 3点メディアンのみ（滑りの速さを測る用）
      const H = Math.round(0.25 / dt); // 0.5秒窓の中央値＝「保っている音」（短い装飾やビブラートを無視、音の段差は保つ）
      const ST = Math.round(P.stableWin / dt);
      for (const [a, b] of runs) {
        // 3) オクターブ飛び補正（±0.2秒の中央値基準）→ 3点メディアン → 3点平均
        const m = new Float64Array(b - a + 1);
        for (let i = a; i <= b; i++) m[i - a] = raw[i];
        const R = 12, fixd = new Float64Array(m.length);
        for (let i = 0; i < m.length; i++) {
          const ref = medianRange(m, Math.max(0, i - R), Math.min(m.length - 1, i + R));
          const d = m[i] - ref, k = Math.round(d / 12);
          fixd[i] = k !== 0 && Math.abs(d - 12 * k) < 2 ? m[i] - 12 * k : m[i];
        }
        const md = new Float64Array(m.length);
        for (let i = 0; i < m.length; i++) M[a + i] = md[i] = i === 0 || i === m.length - 1 ? fixd[i] : median3(fixd[i - 1], fixd[i], fixd[i + 1]);
        for (let i = 0; i < m.length; i++) {
          const lo = Math.max(0, i - 1), hi = Math.min(m.length - 1, i + 1);
          let s = 0;
          for (let k = lo; k <= hi; k++) s += md[k];
          p[a + i] = s / (hi - lo + 1);
        }
        for (let i = a; i <= b; i++) L[i] = medianRange(p, Math.max(a, i - H), Math.min(b, i + H));
      }
      const T = (i) => t0 + i * dt;
      const inVib = (t) => out.vibrato.some((v) => t >= v.t - 0.1 && t <= v.t + v.d + 0.1);

      for (const [a, b] of runs) {
        // 落ち着いた区間： [i, i+ST] の上下幅が stableRange 以下
        const stable = new Uint8Array(b - a + 1);
        for (let i = a; i + ST <= b; i++) {
          let mx = -1e9, mn = 1e9;
          for (let k = i; k <= i + ST; k++) { if (p[k] > mx) mx = p[k]; if (p[k] < mn) mn = p[k]; }
          stable[i - a] = mx - mn <= P.stableRange ? 1 : 0;
        }
        const isStable = (i) => i >= a && i <= b && stable[i - a] === 1;

        // --- しゃくり：落ち着く直前に、下から滑らかにずり上がっている ---
        let lastSh = -1e9;
        for (let i = a; i + ST <= b; i++) {
          if (!isStable(i) || isStable(i - 1)) continue;
          const target = medianRange(p, i, i + ST);
          let k = i, low = i;
          const look = Math.round(P.shakuriLook / dt);
          while (k - 1 >= a && i - (k - 1) <= look && M[k - 1] <= M[k] + 0.25) { k--; if (M[k] < M[low]) low = k; }
          const lv = M[low], rise = target - lv;
          if (rise < P.shakuriRise) continue;
          // 20〜80%の高さにいたフレーム数から滑りの長さを推定（ただの段差は0〜1フレーム）
          let j20 = low, inBand = 0;
          for (let j = low; j <= i; j++) if (M[j] <= lv + 0.2 * rise) j20 = j;
          for (let j = j20; j <= i + ST; j++) { if (M[j] >= lv + 0.8 * rise) break; if (M[j] > lv + 0.2 * rise) inBand++; }
          const dur = inBand * dt / 0.6, j10 = j20;
          if (dur < P.shakuriMin || dur > P.shakuriMax) continue;
          const t = T(j10);
          if (t - lastSh < 0.15) continue;
          out.shakuri.push({ t });
          lastSh = t;
        }

        // --- こぶし：保っている音から一瞬だけ上に跳ねて戻る ---
        const W = Math.round(0.25 / dt), pre = Math.round(0.12 / dt);
        let lastKo = -1e9;
        for (let i = a + 1; i < b; i++) {
          const base = L[i];
          if (p[i] - base < P.kobushiRise || p[i] < p[i - 1] || p[i] <= p[i + 1]) continue;
          let s = i, e = i;
          while (s - 1 >= a && p[s - 1] - base > 0.3) s--;
          while (e + 1 <= b && p[e + 1] - base > 0.3) e++;
          const next = e + 1;
          const dur = (e - s + 1) * dt;
          if (s - a < pre || b - e < pre || dur < P.kobushiMin || dur > P.kobushiMax) { i = next; continue; }
          const peak = p[i], half = base + 0.5 * (peak - base);
          let top = 0;
          for (let k = s; k <= e; k++) if (p[k] > half) top++;
          if (top * dt > P.kobushiTop) { i = next; continue; }
          const before = medianRange(p, s - pre, s - 1), after = medianRange(p, e + 1, e + pre);
          if (Math.abs(before - base) > 0.5 || Math.abs(after - base) > 0.5 || Math.abs(after - before) > 0.6) { i = next; continue; }
          // ビブラートの揺れや音の移り変わりではない（前後に他の大きな揺れがない）
          let busy = false;
          for (let k = Math.max(a, s - W); k <= Math.min(b, e + W) && !busy; k++) {
            if (k >= s && k <= e) continue;
            if (Math.abs(p[k] - base) >= 0.45) busy = true;
          }
          const t = T(s);
          if (busy || inVib(T(i)) || t - lastKo < 0.12) { i = next; continue; }
          out.kobushi.push({ t });
          lastKo = t;
          i = next;
        }

        // --- フォール：伸ばした音の終わりで、声が消える前に下がる ---
        const HW = Math.round(P.fallHold / dt), maxTail = Math.round(P.fallMax / dt), minTail = Math.round(P.fallMin / dt);
        for (let k = b; k >= Math.max(a + HW, b - maxTail - 1); k--) {
          const med = medianRange(p, k - HW, k);
          let ok = 0;
          for (let q = k - HW; q <= k; q++) if (Math.abs(p[q] - med) <= 0.5) ok++;
          if (ok < 0.85 * (HW + 1) || p[k] < med - 0.5) continue;
          // k が伸ばした音の終わり
          const tail = b - k;
          if (tail < minTail || tail > maxTail) break;
          const endLv = medianRange(p, Math.max(k, b - 2), b);
          if (med - endLv < P.fallDrop) break;
          let flat = 0, ups = 0;
          for (let q = k + 1; q <= b; q++) {
            if (Math.abs(p[q] - endLv) <= 0.3) flat++;
            if (q > k + 1 && p[q] > p[q - 1] + 0.3) ups++;
          }
          if (flat * dt > 0.15 || ups > 1) break;
          out.fall.push({ t: T(k) });
          break;
        }
      }
    }
    for (const k of ['shakuri', 'kobushi', 'fall', 'vibrato']) out.counts[k] = out[k].length;
    return out;
  }
  // テクニックの加点（0〜3点）：回数に応じて逓減。ビブラート・こぶしはやや重め
  function techniqueBonus(counts) {
    const W = { shakuri: [0.6, 4], kobushi: [0.8, 3], fall: [0.6, 3], vibrato: [1.0, 4] };
    let b = 0;
    for (const k in W) b += W[k][0] * (1 - Math.exp(-(counts[k] || 0) / W[k][1]));
    return clamp(b, 0, 3);
  }

  // frames: [{t, midi|null, rms}]（曲の時刻順）, guide: [{t,d,midi}] or null
  function scorePerformance(frames, guide, opts) {
    opts = opts || {};
    const transpose = opts.transpose || 0;
    const fr = frames.slice().sort((a, b) => a.t - b.t);
    const voiced = fr.filter((f) => f.midi != null);
    const res = { hasGuide: !!(guide && guide.length), items: {}, notes: [], comments: [] };
    const totalTime = fr.length > 1 ? fr[fr.length - 1].t - fr[0].t : 0;
    const dt = fr.length > 1 ? totalTime / (fr.length - 1) : 1 / 60;
    res.voicedSec = voiced.length * dt;

    const runs = voicedRuns(voiced);
    const detrended = detrendRuns(runs);
    const vib = scanVibrato(detrended);
    const vibratoSec = vib.sec;

    let stableN = 0, stableTotal = 0;
    for (const det of detrended) for (const d of det) {
      stableTotal++;
      if (d.vib || Math.abs(d.dev) < 0.3) stableN++;
    }
    const stability = stableTotal ? stableN / stableTotal : 0;

    // ロングトーン：1秒以上、中央値±0.7半音以内を保つ（中央値は挿入ソートで逐次更新）
    let longCount = 0, longQuality = 0;
    const insertSorted = (arr, x) => {
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
      arr.splice(lo, 0, x);
    };
    for (const r of runs) {
      let s = 0, sorted = [];
      for (let e = 0; e < r.length; e++) {
        const x = r[e].midi;
        insertSorted(sorted, x);
        const md = sorted[sorted.length >> 1];
        if (Math.abs(x - md) > 0.7) {
          if (e > s && r[e - 1].t - r[s].t >= 1.0) { longCount++; longQuality += segQuality(r.slice(s, e)); }
          s = e; sorted = [x];
        }
      }
      if (r.length && r[r.length - 1].t - r[s].t >= 1.0) { longCount++; longQuality += segQuality(r.slice(s)); }
    }
    // 品質：約0.18秒の移動平均（ビブラートを打ち消す）が中央値からどれだけ外れるか
    function segQuality(seg) {
      const vals = seg.map((f) => f.midi);
      const md = median(vals);
      const H = 5;
      let acc = 0;
      for (let i = 0; i < vals.length; i++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, i - H); k <= Math.min(vals.length - 1, i + H); k++) { s += vals[k]; c++; }
        acc += Math.abs(s / c - md);
      }
      return clamp(1 - (acc / vals.length) / 0.4, 0, 1);
    }

    // 抑揚：2秒ごとの音量(dB)のばらつき
    const winDb = [];
    if (voiced.length) {
      let w0 = voiced[0].t, acc = [];
      for (const f of voiced) {
        if (f.t - w0 >= 2) { if (acc.length > 10) winDb.push(acc.reduce((a, b) => a + b, 0) / acc.length); acc = []; w0 = f.t; }
        acc.push(20 * Math.log10(Math.max(1e-5, f.rms || 1e-5)));
      }
      if (acc.length > 10) winDb.push(acc.reduce((a, b) => a + b, 0) / acc.length);
    }
    let dbStd = 0;
    if (winDb.length > 1) {
      const m = winDb.reduce((a, b) => a + b, 0) / winDb.length;
      dbStd = Math.sqrt(winDb.reduce((a, b) => a + (b - m) * (b - m), 0) / winDb.length);
    }
    const expression = clamp((dbStd - 0.5) / 4, 0, 1);

    let pitch = 0, rhythm = null, participation = 1;
    if (res.hasGuide) {
      const g = guide.map((n) => ({ t: n.t, d: n.d, midi: n.midi + transpose }));
      const per = g.map(() => ({ sum: 0, n: 0 }));
      let csum = 0, cn = 0, sungIn = 0;
      for (const f of fr) {
        const idx = findNote(g, f.t);
        if (idx < 0) continue;
        const note = g[idx];
        if (f.t - note.t < 0.08 && f.midi == null) continue; // 出だしの息継ぎは大目に見る
        let c = 0;
        if (f.midi != null) { c = pitchCredit(Math.abs(foldDiff(f.midi, note.midi))); sungIn++; }
        per[idx].sum += c; per[idx].n++;
        csum += c; cn++;
      }
      pitch = cn ? csum / cn : 0;
      participation = cn ? clamp(sungIn / cn / 0.5, 0, 1) : 0;
      res.notes = g.map((n, i) => ({ ...n, credit: per[i].n ? per[i].sum / per[i].n : 0, hit: per[i].n > 0 && per[i].sum / per[i].n >= 0.6 }));
      // リズム：音の出だしと歌い出しのずれ
      // 「この音の高さに切り替わった最初のフレーム」を歌い出しとみなす。
      // 直前の音の伸ばし（レガート）を出だしと誤認しないよう、直前の音より近い高さであることを条件にする。
      const offs = [];
      for (let i = 0; i < g.length; i++) {
        const n = g[i];
        if (n.d < 0.2) continue;
        const pv = i > 0 && g[i - 1].t + g[i - 1].d > n.t - 0.3 ? g[i - 1] : null;
        const same = pv && Math.round(pv.midi) === Math.round(n.midi);
        const near = (x) => {
          const a = Math.abs(foldDiff(x.midi, n.midi));
          return a <= 1 && (!pv || same || a < Math.abs(foldDiff(x.midi, pv.midi)));
        };
        let lo = 0, hi = voiced.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (voiced[mid].t < n.t - 0.25) lo = mid + 1; else hi = mid; }
        for (let j = lo; j < voiced.length && voiced[j].t <= n.t + 0.4; j++) {
          const x = voiced[j];
          if (!near(x)) continue;
          const px = voiced[j - 1];
          const contiguous = px && x.t - px.t <= 0.08 && near(px);
          if (!contiguous) { offs.push(x.t - n.t); break; }
          if (j === lo && !same) { offs.push(-0.25); break; } // 0.25秒以上早く入った
        }
      }
      if (offs.length) {
        const meanAbs = offs.reduce((a, b) => a + Math.abs(b), 0) / offs.length;
        const meanSigned = offs.reduce((a, b) => a + b, 0) / offs.length;
        rhythm = clamp(1 - (meanAbs - 0.05) / 0.3, 0, 1);
        res.timingBias = meanSigned;
      } else rhythm = 0;
    } else {
      // ガイドなし：音階への収まりと、半音グリッドへの近さ
      const hist = new Array(12).fill(0);
      let centsSum = 0, cN = 0;
      for (const det of detrended) for (const d of det) {
        if (Math.abs(d.dev) < 0.3) {
          const r = Math.round(d.midi);
          hist[((r % 12) + 12) % 12]++;
          centsSum += Math.abs(d.midi - r) * 100; cN++;
        }
      }
      const major = [0, 2, 4, 5, 7, 9, 11];
      let best = 0, bestKey = 0;
      const tot = hist.reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < 12; k++) {
        const s = major.reduce((a, iv) => a + hist[(k + iv) % 12], 0) / tot;
        if (s > best) { best = s; bestKey = k; }
      }
      const inton = cN ? clamp(1 - (centsSum / cN - 10) / 20, 0, 1) : 0;
      const scaleFit = clamp((best - 0.6) / 0.35, 0, 1);
      pitch = 0.5 * inton + 0.5 * scaleFit;
      res.key = NOTE_NAMES[bestKey] + 'メジャー（推定）';
      participation = totalTime > 0 ? clamp(res.voicedSec / totalTime / 0.3, 0, 1) : 0;
    }

    const voicedMin = Math.max(1, res.voicedSec / 60);
    const vibrato = clamp(vibratoSec / (res.voicedSec * 0.08 || 1), 0, 1);
    const longtone = clamp(longCount / (3 * voicedMin), 0, 1) * (longCount ? longQuality / longCount : 0);

    const I = res.items;
    I.pitch = { label: res.hasGuide ? '音程' : '音程（ガイドなし）', value: pitch * 100 };
    I.stability = { label: '安定性', value: stability * 100 };
    if (rhythm != null) I.rhythm = { label: 'リズム', value: rhythm * 100 };
    I.expression = { label: '抑揚', value: expression * 100 };
    I.vibrato = { label: 'ビブラート', value: vibrato * 100, extra: vibratoSec.toFixed(1) + '秒' };
    I.longtone = { label: 'ロングトーン', value: longtone * 100, extra: longCount + '回' };

    const w = res.hasGuide
      ? { pitch: 0.6, stability: 0.1, rhythm: 0.1, expression: 0.1, vibrato: 0.05, longtone: 0.05 }
      : { pitch: 0.45, stability: 0.25, expression: 0.15, vibrato: 0.075, longtone: 0.075 };
    let raw = 0;
    for (const k in w) raw += (I[k] ? I[k].value : 0) * w[k];
    raw *= participation;
    res.raw = raw;
    const tech = detectTechniques(fr, { vibrato: vib });
    res.techniques = { counts: tech.counts, events: { shakuri: tech.shakuri, kobushi: tech.kobushi, fall: tech.fall, vibrato: tech.vibrato } };
    res.bonus = res.voicedSec < 3 ? 0 : techniqueBonus(tech.counts);
    res.total = res.voicedSec < 3 ? 0 : Math.min(100, 100 * Math.pow(raw / 100, 0.6) + res.bonus);
    res.participation = participation;
    res.stats = { vibratoSec, longCount, dbStd };

    // コメント
    const C = res.comments;
    if (res.voicedSec < 3) C.push('歌声がほとんど検出できませんでした。マイクの許可と入力音量を確認してください。');
    else {
      if (pitch > 0.85) C.push('音程がとても正確です！');
      else if (pitch < 0.55) C.push(res.hasGuide ? '音程バーをよく見て、音の高さを合わせてみましょう。' : '音程がやや不安定です。音を一つずつ丁寧に当ててみましょう。');
      if (stability < 0.6) C.push('声がふらつきがちです。お腹から息を一定に出すと安定します。');
      if (expression < 0.3) C.push('抑揚が少なめです。サビで声を大きく、Aメロは抑えめにするとメリハリが出ます。');
      if (res.timingBias != null && Math.abs(res.timingBias) > 0.12) C.push(res.timingBias > 0 ? '歌い出しが少し遅れがちです。' : '歌い出しが少し走り気味です。');
      if (vibratoSec < 1) C.push('ロングトーンの最後にビブラートをかけると加点されます。');
      const tc = tech.counts, nTech = tc.shakuri + tc.kobushi + tc.fall + tc.vibrato;
      if (!nTech) C.push('しゃくりやこぶしなどのテクニックを入れると加点されます。');
      else if (nTech >= 20 && (tc.shakuri > 0) + (tc.kobushi > 0) + (tc.fall > 0) + (tc.vibrato > 0) >= 3) C.push('テクニックを豊富に使えています！');
      if (!C.length) C.push('バランスの良い歌唱でした！');
    }
    return res;
  }


  /* ---------- 伴奏入りの音からメロディを拾う（倍音加算） ---------- */
  function fftMag(buf) {
    const n = buf.length; // 2のべき乗
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = buf[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    const mag = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) mag[i] = Math.sqrt(Math.sqrt(re[i] * re[i] + im[i] * im[i])); // 圧縮
    return mag;
  }
  // buf: 4096サンプル推奨。戻り値 {freq, salience, rms}（無音・不明瞭なら freq=0）
  function detectMelody(buf, sampleRate, opts) {
    opts = opts || {};
    const minM = opts.minMidi || 53, maxM = opts.maxMidi || 86, H = opts.harmonics || 6;
    const rmsGate = opts.rmsGate == null ? 0.003 : opts.rmsGate;
    const minRatio = opts.minRatio || 1.6;
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < rmsGate) return { freq: 0, salience: 0, rms };
    const mag = fftMag(buf), binHz = sampleRate / buf.length;
    const at = (f) => { const x = f / binHz, i = Math.floor(x); if (i + 1 >= mag.length) return 0; return Math.max(mag[i], mag[i + 1]); };
    const sal = [];
    let best = -1, bestM = 0;
    for (let m = minM; m <= maxM; m += 0.1) {
      const f0 = midiToFreq(m);
      let s = 0;
      for (let h = 1; h <= H; h++) s += Math.pow(0.8, h - 1) * at(f0 * h);
      s *= 0.5 + 0.5 * Math.min(1, at(f0) / (at(f0 * 2) + 1e-9)); // 基音が弱い候補（オクターブ下）を減点
      sal.push(s);
      if (s > best) { best = s; bestM = m; }
    }
    const sorted = sal.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1] || 1e-9;
    if (best / med < minRatio) return { freq: 0, salience: best / med, rms };
    return { freq: midiToFreq(bestM), salience: best / med, rms };
  }

  /* ---------- 動画の音程バー（画面）の読み取り ---------- */
  // ピンクの音程バー・現在位置の縦線を想定（例: ガイドメロ付きカラオケ動画）
  function isBarPink(r, g, b) { return r > 190 && g < 150 && b > 110 && r - g > 80; }
  // img: {data, width, height}（RGBA）, rect: 動画の範囲 {x,y,w,h}（img の画素座標）
  // 縦線（現在位置）と音程バーの帯を探す。見つからなければ null
  function isLight(r, g, b) { const mn = Math.min(r, g, b), mx = Math.max(r, g, b); return mn > 135 && mx - mn < 45; }
  function findBarLayout(img, rect) {
    // まずピンクの縦線を探し、無ければ（曲間などで線が白い時）明るい縦線を探す
    return findBarLayoutBy(img, rect, isBarPink, 0.08) || findBarLayoutBy(img, rect, (r, g, b) => isBarPink(r, g, b) || isLight(r, g, b), 0.15);
  }
  function findBarLayoutBy(img, rect, test, minRun) {
    const { data, width } = img;
    const x0 = Math.round(rect.x + rect.w * 0.12), x1 = Math.round(rect.x + rect.w * 0.6);
    const y0 = Math.round(rect.y), y1 = Math.round(rect.y + rect.h * 0.45);
    let best = { run: 0 };
    const runs = [];
    for (let x = x0; x <= x1; x++) {
      let run = 0, gap = 0, start = -1, bestRun = 0, bs = 0, be = 0;
      for (let y = y0; y < y1; y++) {
        const i = (y * width + x) * 4;
        if (test(data[i], data[i + 1], data[i + 2])) {
          if (run === 0) start = y;
          run += 1 + gap; gap = 0;
          if (run > bestRun) { bestRun = run; bs = start; be = y; }
        } else if (run > 0 && gap < 3) gap++;
        else { run = 0; gap = 0; }
      }
      runs.push({ x, run: bestRun, top: bs, bottom: be });
      if (bestRun > best.run) best = { x, run: bestRun, top: bs, bottom: be };
    }
    if (best.run < rect.h * minRun) return null;
    // 縦線の太さ分をまとめる
    const cols = runs.filter((c) => c.run >= best.run * 0.7 && Math.abs(c.x - best.x) <= rect.w * 0.01);
    const lineLeft = Math.min(...cols.map((c) => c.x)), lineRight = Math.max(...cols.map((c) => c.x));
    const top = best.top, bottom = best.bottom;
    // 五線の間隔（明るい横線）を探して、半音の高さ＝間隔の半分とする
    let step = null;
    const xa = Math.round(lineRight + rect.w * 0.05), xb = Math.round(rect.x + rect.w * 0.98);
    const rows = [];
    for (let y = top; y <= bottom; y++) {
      let s = 0, n = 0;
      for (let x = xa; x < xb; x += 2) {
        const i = (y * width + x) * 4;
        if (isBarPink(data[i], data[i + 1], data[i + 2])) continue;
        s += data[i] + data[i + 1] + data[i + 2]; n++;
      }
      rows.push(n ? s / n : 0);
    }
    // 明るい横線（五線）だけを拾う：一番目立つ線の6割以上の強さのものに限る
    const cand = [];
    for (let i = 2; i < rows.length - 2; i++) {
      const loc = Math.min(rows[i - 2], rows[i + 2]);
      if (rows[i] >= rows[i - 1] && rows[i] >= rows[i + 1] && rows[i] - loc > 12) cand.push({ i, prom: rows[i] - loc });
    }
    const maxProm = Math.max(0, ...cand.map((c) => c.prom));
    const peaks = cand.filter((c) => c.prom >= maxProm * 0.6).map((c) => c.i);
    if (peaks.length >= 4) {
      const diffs = [];
      for (let i = 1; i < peaks.length; i++) if (peaks[i] - peaks[i - 1] >= 4) diffs.push(peaks[i] - peaks[i - 1]);
      if (diffs.length >= 3) {
        // 最初と最後の線の距離から割り出して、小さい画面でも端数まで正確にする
        const md = median(diffs), span = peaks[peaks.length - 1] - peaks[0];
        step = span / Math.max(1, Math.round(span / md)) / 2;
      }
    }
    if (!step || step < 1.5) step = (bottom - top) / 25.6;
    return { lineLeft, lineRight, top, bottom, step };
  }
  // 現在位置のすぐ右にあるバーの高さを読む。戻り値: 帯の下端からの半音数（相対）または null（休符）
  function readBarPitch(img, rect, layout) {
    const { data, width } = img;
    const xa = Math.round(layout.lineRight + Math.max(2, rect.w * 0.003)), xb = Math.round(layout.lineRight + rect.w * 0.014);
    for (let x = xa; x <= xb; x++) {
      const ys = [];
      for (let y = layout.top; y <= layout.bottom; y++) {
        const i = (y * width + x) * 4;
        if (isBarPink(data[i], data[i + 1], data[i + 2])) ys.push(y);
      }
      if (ys.length >= 2 && ys.length < (layout.bottom - layout.top) * 0.5) {
        const y = median(ys);
        return { rel: (layout.bottom - y) / layout.step, y };
      }
    }
    return null;
  }
  // (相対値, 実音) の組から、相対値→MIDI のずれ（オフセット）を推定
  // pairs: [{rel, midi}]（midi は動画のガイド音や歌声）。オクターブ違いを許して最も合うずれを探し、
  // 最後にオクターブを midi の中央値に寄せる。戻り値 {offset, fit(0-1)} または null
  function estimateBarOffset(pairs) {
    if (!pairs || pairs.length < 10) return null;
    let best = -1, bestC = 0;
    for (let c = 0; c < 12; c += 0.1) {
      let sc = 0;
      for (const p of pairs) sc += pitchCredit(Math.abs(foldDiff(p.midi, p.rel + c)));
      if (sc > best) { best = sc; bestC = c; }
    }
    const oct = Math.round(median(pairs.map((p) => p.midi - (p.rel + bestC))) / 12) * 12;
    return { offset: bestC + oct, fit: best / pairs.length };
  }

  // 歌声（userFrames: [{t, midi}]）と画面バー（barFrames: [{t, rel}]）を照らし合わせ、
  // 高さのずれ（offset）と時間のずれ（shift: 歌声側の時刻に足す秒）を推定する。
  function estimateBarAlignment(userFrames, barFrames, opts) {
    opts = opts || {};
    const shifts = opts.shifts || [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3];
    const bf = barFrames.filter((f) => f.t != null).sort((a, b) => a.t - b.t);
    const uf = userFrames.filter((f) => f.midi != null).sort((a, b) => a.t - b.t);
    const stride = Math.max(1, Math.floor(uf.length / 4000));
    let best = null;
    for (const sh of shifts) {
      const pairs = [];
      let j = 0;
      for (let i = 0; i < uf.length; i += stride) {
        const tt = uf[i].t + sh;
        while (j + 1 < bf.length && bf[j + 1].t <= tt) j++;
        const b = bf[j];
        if (b && b.rel != null && tt >= b.t && tt - b.t < 0.1) pairs.push({ rel: b.rel, midi: uf[i].midi });
      }
      const e = estimateBarOffset(pairs);
      if (e && (!best || e.fit > best.fit)) best = { offset: e.offset, fit: e.fit, shift: sh, pairs: pairs.length };
    }
    return best;
  }

  const api = {
    NOTE_NAMES, clamp, freqToMidi, midiToFreq, midiName, parseVideoId, detectPitch,
    parseLrc, formatStamp, parseMidi, toMonophonic, framesToNotes, findNote, foldDiff,
    pitchCredit, scorePerformance, detectTechniques, techniqueBonus, detectMelody, findBarLayout, readBarPitch, estimateBarOffset, estimateBarAlignment,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KaraCore = api;
})(typeof self !== 'undefined' ? self : this);
