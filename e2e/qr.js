// 「スマホへQRで送る」のE2E確認。静的サーバー(port 8765)が必要
// PCで作ったQR用URLを、別の端末（スマホ表示の別コンテキスト）で順不同に開いて取り込めるかを見る
// 実行: LANG=C.UTF-8 node e2e/qr.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const BASE = 'http://localhost:8765/';
const MOCK = fs.readFileSync(path.join(__dirname, 'yt-mock.js'), 'utf8');
let failed = 0;
const check = (n, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (info !== undefined ? '  -- ' + JSON.stringify(info) : '')); if (!ok) failed++; };
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  // PC
  const pc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await pc.route('**://www.youtube.com/iframe_api*', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  const page = await pc.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const ID = 'dQw4w9WgXcQ';
  const guide = []; let t = 5;
  for (let i = 0; i < 700; i++) { const d = [0.12, 0.25, 0.5, 0.08][i % 4] + (i % 7) * 0.01; guide.push({ t: +t.toFixed(3), d, midi: 55 + ((i * 7) % 15) }); t += d + 0.06 + (i % 3) * 0.02; }
  await page.addInitScript(([id, g]) => {
    if (!localStorage.getItem('utascore.songs.v1')) localStorage.setItem('utascore.songs.v1', JSON.stringify({ [id]: { title: 'テスト曲（QR）', offset: 0.1, transpose: -2, guide: g, guideSource: '画面の音程バー', history: [] } }));
    localStorage.setItem('utascore.last', id); localStorage.setItem('utascore.consent.v1', '1');
  }, [ID, guide]);
  await page.goto(BASE);
  if (await page.isVisible('#consentOkBtn')) await page.click('#consentOkBtn');
  await page.waitForFunction(() => !document.getElementById('singBtn').disabled);
  await page.click('#qrSendBtn');
  await page.waitForSelector('#qrModal.show');
  const urls = await page.evaluate(() => window.__utascoreQrUrls);
  const img = await page.$eval('#qrBox img', (el) => ({ w: el.width, src: el.src.slice(0, 22) }));
  check('QR shown', img.w > 150 && img.src.startsWith('data:image/gif'), img);
  check('split into a few QR codes', urls.length >= 1 && urls.length <= 6 && urls.every((u) => u.length < 1000), { n: urls.length, lens: urls.map((u) => u.length) });
  if (urls.length > 1) { await page.click('#qrNextBtn'); check('next QR page', (await page.textContent('#qrPage')).startsWith('2 /')); }
  await page.screenshot({ path: path.join(__dirname, 'shots', 'qr-pc.png') });
  // スマホ
  const ph = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
  await ph.route('**://www.youtube.com/iframe_api*', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  const mob = await ph.newPage();
  mob.on('pageerror', (e) => errors.push(e.message));
  const order = urls.map((u, i) => i).reverse();
  for (const i of order) { await mob.goto(urls[i]); await mob.waitForTimeout(500); }
  const got = await mob.evaluate((id) => { const s = JSON.parse(localStorage.getItem('utascore.songs.v1') || '{}')[id]; return s && { n: s.guide.length, g: s.guide, src: s.guideSource, title: s.title, o: s.offset, k: s.transpose, hash: location.hash }; }, ID);
  let maxErr = 0;
  if (got) got.g.forEach((n, i) => { maxErr = Math.max(maxErr, Math.abs(n.t - guide[i].t), Math.abs(n.d - guide[i].d), n.midi === guide[i].midi ? 0 : 99); });
  check('phone imported the guide', got && got.n === guide.length && maxErr <= 0.011 && got.src === '画面の音程バー' && !!got.title && got.o === 0.1 && got.k === -2, got && { n: got.n, maxErr, src: got.src, title: got.title });
  check('data removed from the address bar', got && got.hash === '', got && got.hash);
  const leftovers = await mob.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('utascore.qr.')));
  check('temporary parts cleaned up', leftovers.length === 0, leftovers);
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(failed ? failed + ' FAILED' : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
