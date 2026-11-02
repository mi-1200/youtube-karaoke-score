// 「画面の音程バーでリアルタイム判定」のE2E確認。静的サーバー(port 8765)が必要
// タブ共有を、音程バー入りの映像＋ガイドメロの音を出す合成ストリームに差し替えて確認する
// 実行: LANG=C.UTF-8 node e2e/screenbar.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const BASE = 'http://localhost:8765/';
const MOCK = fs.readFileSync(path.join(__dirname, 'yt-mock.js'), 'utf8');
const TONE = path.join(__dirname, 'tone.wav');
let failed = 0;
const check = (n, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (info !== undefined ? '  -- ' + JSON.stringify(info) : '')); if (!ok) failed++; };
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + TONE, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(['microphone'], { origin: BASE });
  await ctx.route('**://www.youtube.com/iframe_api*', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.click('#consentOkBtn');
  await page.fill('#urlInput', 'https://youtu.be/dQw4w9WgXcQ');
  await page.click('#loadBtn');
  await page.waitForFunction(() => !document.getElementById('singBtn').disabled);
  await page.evaluate(() => {
    const MEL = []; let t = 0.6;
    const seq = [62, 64, 66, 67, 69, 67, 66, 64, 62, 69, 71, 69, 67, 66, 64, 62, 64, 66, 67, 64];
    // 短いバー（0.12秒）も混ぜる
    seq.forEach((m, i) => { const d = i % 4 === 3 ? 0.9 : i % 4 === 1 ? 0.12 : 0.45; MEL.push({ t, d, midi: m }); t += d + 0.08; });
    window.__MEL = MEL;
    navigator.mediaDevices.getDisplayMedia = async () => {
      const cv = document.createElement('canvas'); cv.width = innerWidth; cv.height = innerHeight;
      const g = cv.getContext('2d');
      const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator(); osc.type = 'sawtooth'; const gain = ac.createGain(); gain.gain.value = 0;
      osc.connect(gain); gain.connect(dest); osc.start();
      [43, 50, 55].forEach((m) => { const o = ac.createOscillator(); o.frequency.value = 440 * Math.pow(2, (m - 69) / 12); const gg = ac.createGain(); gg.gain.value = 0.03; o.connect(gg); gg.connect(dest); o.start(); });
      function frame() {
        const P = window.__ytPlayer, now = P ? P.getCurrentTime() : 0;
        const el = document.getElementById('player'); const r = el.getBoundingClientRect();
        g.fillStyle = '#111'; g.fillRect(0, 0, cv.width, cv.height);
        g.fillStyle = '#3a3a40'; g.fillRect(r.left, r.top, r.width, r.height);
        const top = r.top + r.height * 0.015, bandH = r.height * 0.185, step = bandH / 25, bottom = top + bandH;
        g.fillStyle = '#4a4a50'; g.fillRect(r.left, top, r.width, bandH);
        g.fillStyle = '#aaa'; for (let k = 2; k < 25; k += 2) g.fillRect(r.left, bottom - k * step - 0.5, r.width, 1);
        const lineX = r.left + r.width * 0.33, pps = r.width * 0.2;
        g.fillStyle = 'rgb(255,90,170)'; g.fillRect(lineX - 1.5, top, 3, bandH);
        let cur = null;
        for (const n of MEL) {
          const xa = lineX + (n.t - now) * pps, xb = xa + n.d * pps;
          if (xb < r.left || xa > r.left + r.width) continue;
          const y = bottom - (n.midi - 55) * step;
          g.fillStyle = xb < lineX ? '#ddd' : 'rgb(255,90,170)';
          g.fillRect(Math.max(xa, r.left), y - step * 0.7, xb - Math.max(xa, r.left), step * 1.4);
          if (n.t <= now && now < n.t + n.d) cur = n;
        }
        if (cur && P && P._playing) { osc.frequency.value = 440 * Math.pow(2, (cur.midi - 69) / 12); gain.gain.value = 0.15; } else gain.gain.value = 0;
        requestAnimationFrame(frame);
      }
      frame();
      return new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    };
  });
  if (process.env.DBG) {
    const d = await page.evaluate(async () => {
      const st = await navigator.mediaDevices.getDisplayMedia(); const v = document.createElement('video'); v.muted = true; v.srcObject = st; await v.play();
      await new Promise((r) => setTimeout(r, 500));
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0);
      const el = document.getElementById('player'); const r = el.getBoundingClientRect(); const sx = v.videoWidth / innerWidth;
      const rect = { x: r.left * sx, y: r.top * sx, w: r.width * sx, h: r.height * sx };
      const img = g.getImageData(0, 0, c.width, c.height);
      const px = (x, y) => Array.from(img.data.slice((Math.round(y) * c.width + Math.round(x)) * 4, (Math.round(y) * c.width + Math.round(x)) * 4 + 3));
      return { vw: v.videoWidth, vh: v.videoHeight, iw: innerWidth, rect, L: KaraCore.findBarLayout(img, rect), lineColor: px(rect.x + rect.w * 0.33, rect.y + rect.h * 0.1), url: c.toDataURL().length };
    });
    console.log(JSON.stringify(d));
  }
  await page.click('#micBtn');
  await page.click('#screenBarBtn');
  check('experimental confirm shown', await page.isVisible('#expModal'));
  await page.click('#expOkBtn');
  await page.waitForTimeout(800);
  check('screen reading started', (await page.textContent('#screenBarBtn')).includes('やめる'));
  if (process.env.DBG) {
    await page.waitForTimeout(1500);
    console.log(JSON.stringify(await page.evaluate(() => { const S = window.__utascoreScreen(); const r = { vw: S.video.videoWidth, vh: S.video.videoHeight, layout: S.layout, useFull: S.useFull, cw: S.canvas.width, ch: S.canvas.height, rel: S.rel, ready: S.video.readyState, paused: S.video.paused };
      const d = S.ctx.getImageData(0, 0, S.canvas.width, S.canvas.height).data; let pink = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] < 150) pink++; r.pink = pink; r.px = [0, 100, 200].map((y) => Array.from(d.slice((y * S.canvas.width + 300) * 4, (y * S.canvas.width + 300) * 4 + 3))); return r; })));
  }
  await page.click('#singBtn');
  await page.waitForTimeout(13500);
  const status = await page.textContent('#screenStatus');
  check('layout detected and offset calibrated', status.includes('音程バーを検出') && status.includes('高さ合わせ完了'), status);
  await page.click('#stopBtn');
  await page.waitForSelector('#resultModal.show');
  check('result uses guide mode', (await page.textContent('#resMode')).includes('ガイドメロディ採点'), await page.textContent('#resMode'));
  await page.click('#closeResBtn');
  const gs = await page.textContent('#guideStatus');
  check('screen guide saved', gs.includes('画面の音程バー'), gs);
  const acc = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('utascore.songs.v1'))['dQw4w9WgXcQ'];
    let ok = 0; const notes = s.guide;
    for (const n of notes) { const mid = n.t + n.d / 2; const m = window.__MEL.find((x) => x.t <= mid && mid < x.t + x.d); if (m && m.midi === n.midi) ok++; }
    const covered = window.__MEL.filter((m) => m.t < 12.5 && notes.some((n) => n.midi === m.midi && Math.abs(n.t - m.t) < 0.15)).length;
    const shorts = window.__MEL.filter((m) => m.d < 0.2 && m.t < 12.5); const shortCovered = shorts.filter((m) => notes.some((n) => n.midi === m.midi && Math.abs(n.t - m.t) < 0.08 && Math.abs(n.d - m.d) < 0.08)).length;
    return { shortInRange: shorts.length, shortCovered, notes: notes.length, exact: ok, covered, melInRange: window.__MEL.filter((m) => m.t < 12.5).length, sample: notes.slice(0, 6).map((n) => n.midi + '@' + n.t.toFixed(2)) };
  });
  check('saved guide matches the on-screen melody', acc.exact >= acc.notes * 0.8 && acc.covered >= acc.melInRange * 0.8, acc);
  check('short bars captured', acc.shortCovered === acc.shortInRange && acc.shortInRange > 0, acc);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const exp = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
  check('export omits guide read from the screen', exp.guide === null && exp.guideSource === '', { guide: exp.guide && exp.guide.length, src: exp.guideSource });
  const dbg = await page.evaluate(() => JSON.parse(localStorage.getItem('utascore.debug.v1') || '[]')[0]);
  check('debug log has screen info', dbg && dbg.screen && dbg.screen.layout && dbg.screen.frames.t.length > 50, dbg && dbg.screen && { offset: dbg.screen.offset, fit: dbg.screen.fit, src: dbg.screen.offsetSrc, step: dbg.screen.layout && dbg.screen.layout.step });
  if (process.env.DBG2) console.log(JSON.stringify({ speed: dbg.screen.speed, n: dbg.screen.speeds, bars: dbg.screen.bars.slice(0, 40), guide: await page.evaluate(() => JSON.parse(localStorage.getItem('utascore.songs.v1'))['dQw4w9WgXcQ'].guide.map((n) => [+n.t.toFixed(2), +n.d.toFixed(2), n.midi])), mel: await page.evaluate(() => window.__MEL.map((n) => [+n.t.toFixed(2), n.d, n.midi])) }));
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(failed ? failed + ' FAILED' : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
