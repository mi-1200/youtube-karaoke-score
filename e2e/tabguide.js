// 「動画の音から作る」とバージョン表示のE2E確認。静的サーバー(port 8765)が必要
// 実行: LANG=C.UTF-8 node e2e/tabguide.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const BASE = 'http://localhost:8765/';
const MOCK = fs.readFileSync(path.join(__dirname, 'yt-mock.js'), 'utf8');
let failed = 0;
const check = (n, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (info !== undefined ? '  -- ' + JSON.stringify(info) : '')); if (!ok) failed++; };
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**://www.youtube.com/iframe_api*', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.click('#consentOkBtn');
  check('version label', /^うたスコア v\d+\.\d+\.\d+/.test(await page.textContent('#verLabel')), await page.textContent('#verLabel'));
  await page.click('#changelogBtn');
  check('changelog modal lists versions', (await page.$$('#changelogBody .cl-ver')).length >= 3);
  await page.click('#closeChangelogBtn');
  await page.fill('#urlInput', 'https://youtu.be/dQw4w9WgXcQ');
  await page.click('#loadBtn');
  await page.waitForFunction(() => !document.getElementById('singBtn').disabled);
  // ヘッドレスではタブ共有ができないため、getDisplayMedia を「伴奏＋旋律を鳴らすストリーム」に差し替える
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
      const f = (m) => 440 * Math.pow(2, (m - 69) / 12);
      const seq = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60];
      let t = ac.currentTime + 0.3;
      seq.forEach((m) => { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f(m); const g = ac.createGain(); g.gain.value = 0.15; o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.45); t += 0.5; });
      [48, 52, 55].forEach((m) => { const o = ac.createOscillator(); o.frequency.value = f(m); const g = ac.createGain(); g.gain.value = 0.05; o.connect(g); g.connect(dest); o.start(); o.stop(t); });
      const cv = document.createElement('canvas'); cv.width = 16; cv.height = 16; cv.getContext('2d').fillRect(0, 0, 16, 16);
      return new MediaStream([...dest.stream.getAudioTracks(), ...cv.captureStream(1).getVideoTracks()]);
    };
  });
  await page.click('#tabGuideBtn');
  await page.click('#expOkBtn');
  await page.waitForTimeout(1000);
  const ml = await page.textContent('#modeLine');
  if (!ml.includes('動画の音から')) { check('tab capture started', false, ml); }
  else {
    await page.waitForTimeout(8000);
    await page.click('#stopBtn');
    await page.waitForTimeout(500);
    const st = await page.textContent('#guideStatus');
    check('guide from tab audio', st.includes('動画の音'), [st, await page.textContent('#modeLine')]);
  }
  const dbg = await page.evaluate(() => JSON.parse(localStorage.getItem('utascore.debug.v1') || '[]').map((l) => [l.kind, l.appVersion]));
  check('debug log has appVersion', dbg.length > 0 && /\d+\.\d+\.\d+/.test(dbg[0][1]), dbg);
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(failed ? failed + ' FAILED' : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
