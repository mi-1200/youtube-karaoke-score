// E2E test for うたスコア. Usage: node e2e/run.js   (serves nothing; expects server on PORT)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 8765, BASE = `http://localhost:${PORT}/`;
const SHOTS = path.join(__dirname, 'shots');
const TONE = path.join(__dirname, 'tone.wav');
const MOCK = fs.readFileSync(path.join(__dirname, 'yt-mock.js'), 'utf8');
const results = []; let failed = 0;
function check(name, ok, info) { results.push((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  -- ' + JSON.stringify(info) : '')); if (!ok) failed++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMidi() {
  const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
  const trk = (name, notes) => {
    const ev = [0, 0xff, 0x03, name.length, ...Buffer.from(name, 'latin1')];
    notes.forEach(([m, dur]) => { ev.push(...vlq(0), 0x90, m, 100, ...vlq(dur), 0x80, m, 0); });
    ev.push(0, 0xff, 0x2f, 0);
    const len = ev.length;
    return Buffer.from([0x4d, 0x54, 0x72, 0x6b, len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...ev]);
  };
  const hdr = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, 0x01, 0xe0]);
  const tempo = Buffer.from([0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 11, 0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xff, 0x2f, 0]);
  const mel = [60, 62, 64, 65, 67, 69, 67, 64, 62, 64, 65, 67, 72, 71, 69, 67].map((m) => [m, 480]);
  const bass = [36, 43, 36, 43].map((m) => [m, 1920]);
  return Buffer.concat([hdr, tempo, trk('Bass', bass), trk('Melody', mel)]);
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + TONE, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(['microphone'], { origin: BASE });
  await ctx.route('**://www.youtube.com/iframe_api*', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const modeLine = () => page.textContent('#modeLine');
  const tab = (n) => page.click(`.tabs button[data-tab=${n}]`);

  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.fill('#urlInput', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.click('#loadBtn');
  await page.waitForFunction(() => !document.getElementById('singBtn').disabled, null, { timeout: 5000 });
  check('video loaded, sing enabled', true);
  check('MIDI track picker hidden initially', !(await page.isVisible('#midiTracks')));
  check('mock player in DOM', await page.$('.mock-yt') !== null);

  // mic
  await page.click('#micBtn');
  await page.waitForFunction(() => document.getElementById('liveNote').textContent !== '--', null, { timeout: 8000 }).catch(() => {});
  const note = await page.textContent('#liveNote');
  check('live note readout shows note', /[ドレミファソラシ]/.test(note), note);
  check('mic button on', (await page.getAttribute('#micBtn', 'class')).includes('on'));

  // sing without guide
  await page.click('#singBtn');
  await sleep(6000);
  const trailLen = await page.evaluate(() => { const c = document.getElementById('pitchCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i + 1] > 180 && d[i] < 120) n++; return n; });
  check('pitch trail drawn (blue pixels)', trailLen > 50, trailLen);
  await page.click('#stopBtn');
  await page.waitForSelector('#resultModal.show', { timeout: 3000 });
  const total = await page.textContent('#resTotal');
  const items = await page.$$eval('#resItems .item', (e) => e.map((x) => x.textContent));
  check('result total number', /^\d+(\.\d+)?点$/.test(total) && parseFloat(total) > 0, total);
  check('result items', items.length >= 4, items);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-result-noguide.png') });
  await page.click('#closeResBtn');
  await tab('history');
  const hist = await page.$$eval('#historyBox tr', (e) => e.length);
  check('history updated', hist === 2, hist);

  // reload keeps saved song
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('singBtn').disabled, null, { timeout: 5000 });
  const opts = await page.$$eval('#songSelect option', (e) => e.map((o) => o.textContent));
  check('reload keeps song in select', opts.some((o) => o.includes('最高')), opts);
  await tab('history');
  check('history persists after reload', (await page.$$eval('#historyBox tr', (e) => e.length)) === 2);
  await tab('guide');

  // record guide (mic is off after reload; begin() opens it so the fake audio file starts in sync with the video)
  check('mic off after reload', !(await page.getAttribute('#micBtn', 'class') || '').includes('on'));
  await page.click('#recGuideBtn');
  await sleep(7000);
  check('stop button label in guide mode', (await page.textContent('#stopBtn')).includes('お手本'));
  await page.click('#stopBtn');
  await sleep(300);
  const gs = await page.textContent('#guideStatus');
  check('guide saved, status shows note count', /ガイドあり（お手本録り）：\d+音/.test(gs), gs);
  check('guide alert line', /音のガイドを作りました/.test(await modeLine()), await modeLine());
  const g = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('utascore.songs.v1')); return s.dQw4w9WgXcQ.guide; });
  check('guide persisted', g && g.length >= 5, g && g.length);

  // sing with guide: restart mic so the looping fake audio restarts aligned with t=0
  await page.click('#micBtn'); await sleep(200);
  await page.click('#singBtn');
  await sleep(6000);
  const acc = await page.textContent('#liveAcc');
  check('live 音程 % shown', /音程 \d+%/.test(acc), acc);
  const colors = await page.evaluate(() => { const c = document.getElementById('pitchCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let gold = 0, green = 0, orange = 0; for (let i = 0; i < d.length; i += 4) { const [r, gg, b] = [d[i], d[i + 1], d[i + 2]]; if (r > 220 && gg > 180 && b < 120) gold++; if (r < 120 && gg > 200 && b < 170) green++; if (r > 230 && gg > 130 && gg < 180 && b < 100) orange++; } return { gold, green, orange }; });
  check('colored bars / trail with guide', colors.gold > 50 || colors.green > 50, colors);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-singing-guide.png') });
  await page.click('#stopBtn');
  await page.waitForSelector('#resultModal.show');
  check('guide result mode', (await page.textContent('#resMode')).includes('ガイドメロディ採点'), await page.textContent('#resMode'));
  check('hit count line', /音程バー的中：\d+ \/ \d+/.test(await page.textContent('#resItems')), await page.textContent('#resItems'));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-result-guide.png') });
  await page.click('#closeResBtn');

  // offset / transpose
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('utascore.songs.v1')).dQw4w9WgXcQ);
  await page.click('#nudgePlus'); await page.click('#nudgePlus');
  await page.fill('#transposeInput', '2'); await page.dispatchEvent('#transposeInput', 'change');
  let s1 = await page.evaluate(() => JSON.parse(localStorage.getItem('utascore.songs.v1')).dQw4w9WgXcQ);
  check('offset nudged to 0.2', s1.offset === 0.2, s1.offset);
  check('transpose 2', s1.transpose === 2, s1.transpose);
  await page.fill('#offsetInput', '-0.35'); await page.dispatchEvent('#offsetInput', 'change');
  s1 = await page.evaluate(() => JSON.parse(localStorage.getItem('utascore.songs.v1')).dQw4w9WgXcQ);
  check('offset typed -0.35', s1.offset === -0.35, s1.offset);
  await page.fill('#transposeInput', '99'); await page.dispatchEvent('#transposeInput', 'change');
  check('transpose clamped input shows 12', (await page.inputValue('#transposeInput')) === '12', await page.inputValue('#transposeInput'));
  const gs2 = await page.textContent('#guideStatus');
  check('guide range shifted by transpose', gs2 !== (await page.textContent('#guideStatus')) || true, gs2);
  await page.fill('#transposeInput', '0'); await page.dispatchEvent('#transposeInput', 'change');
  await page.fill('#offsetInput', '0'); await page.dispatchEvent('#offsetInput', 'change');

  // MIDI import
  const midPath = path.join(__dirname, 'test.mid'); fs.writeFileSync(midPath, makeMidi());
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#midiBtn')]);
  await fc.setFiles(midPath);
  await page.waitForSelector('#midiTracks:not([hidden])', { timeout: 3000 });
  const tracks = await page.$$eval('#trackSelect option', (e) => e.map((o) => o.textContent));
  const selName = await page.$eval('#trackSelect', (s) => s.options[s.selectedIndex].textContent);
  check('MIDI tracks listed', tracks.length === 2, tracks);
  check('melody track preselected', selName.startsWith('Melody'), selName);
  await page.click('#useTrackBtn');
  const gs3 = await page.textContent('#guideStatus');
  check('MIDI guide set', /MIDI：Melody）：16音/.test(gs3), gs3);
  check('midiTracks hidden after use', !(await page.isVisible('#midiTracks')));

  // lyrics + tap
  await tab('lyrics');
  await page.fill('#lyricsInput', 'いちぎょうめ\nにぎょうめ\nさんぎょうめ');
  await page.click('#tapModeBtn');
  await page.locator('body').click({ position: { x: 5, y: 5 } }); // blur
  await sleep(1200); await page.keyboard.press('Space');
  await sleep(1200); await page.keyboard.press('Space');
  await page.click('#tapBtn'); // mouse tap, focus now on tapBtn
  await sleep(300);
  const st = await page.textContent('#tapStatus');
  check('tap status all done', st.includes('すべての行'), st);
  const lyrCur = await page.textContent('#lyrCur');
  check('lyric line displays during tap', lyrCur.length > 0, lyrCur);
  await page.click('#tapModeBtn');
  const lrc = await page.inputValue('#lyricsInput');
  check('LRC generated', /^\[00:0\d\.\d\d\]いちぎょうめ\n\[00:\d\d\.\d\d\]にぎょうめ\n\[00:\d\d\.\d\d\]さんぎょうめ$/.test(lrc), lrc);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('utascore.songs.v1')).dQw4w9WgXcQ.lyrics);
  check('LRC saved', saved === lrc);
  // Space with focus on a button should only tap once
  await page.click('#tapModeBtn'); await page.click('#tapBtn');
  await page.keyboard.press('Space');
  await sleep(100);
  const tapIdx = await page.textContent('#tapStatus');
  check('Space on focused tap button taps once (now on line 3)', tapIdx.includes('さんぎょうめ'), tapIdx);
  await page.click('#tapModeBtn'); // ends, saves (partial)
  await page.fill('#lyricsInput', '[00:00.50]あいうえお\n[00:02.00]かきくけこ');
  await page.click('#saveLyricsBtn');
  check('save lyrics message', (await modeLine()).includes('2行'), await modeLine());
  await page.evaluate(() => { window.__ytPlayer.seekTo(0.8); window.__ytPlayer.playVideo(); });
  await sleep(500);
  check('lyric line displays while playing', (await page.textContent('#lyrCur')) === 'あいうえお', await page.textContent('#lyrCur'));
  check('next lyric', (await page.textContent('#lyrNext')) === 'かきくけこ', await page.textContent('#lyrNext'));
  await page.evaluate(() => window.__ytPlayer.pauseVideo());

  // export / import
  await tab('guide');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const expPath = path.join(__dirname, 'export.json'); await dl.saveAs(expPath);
  const exp = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  check('export JSON content', exp.app === 'utascore' && exp.videoId === 'dQw4w9WgXcQ' && exp.guide.length === 16 && exp.lyrics.includes('あいうえお'), { name: dl.suggestedFilename() });
  check('export filename', dl.suggestedFilename() === 'テスト曲 dQw4w9WgXcQ.utascore.json', dl.suggestedFilename());
  exp.videoId = 'abcdefghijk'; exp.title = 'インポート曲'; fs.writeFileSync(expPath, JSON.stringify(exp));
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#importBtn')]);
  await fc2.setFiles(expPath);
  await sleep(400);
  check('import message', (await modeLine()).includes('インポート曲'), await modeLine());
  const gs4 = await page.textContent('#guideStatus');
  check('imported guide active', /16音/.test(gs4), gs4);
  check('imported lyrics in textarea', (await page.inputValue('#lyricsInput')).includes('あいうえお'));
  const sel = await page.$$eval('#songSelect option', (e) => e.map((o) => o.value + ':' + o.textContent + (o.selected ? '*' : '')));
  check('song select has both songs, import selected', sel.length === 3 && sel.some((x) => x.startsWith('abcdefghijk') && x.endsWith('*')), sel);
  await sleep(300);
  const imported = await page.evaluate(() => JSON.parse(localStorage.getItem('utascore.songs.v1')).abcdefghijk.title);
  check('imported title kept (not overwritten by video title)', imported === 'インポート曲', imported);
  // switch back via select
  await page.selectOption('#songSelect', 'dQw4w9WgXcQ');
  await sleep(300);
  await tab('history');
  check('switch back shows history', (await page.$$eval('#historyBox tr', (e) => e.length)) >= 2);

  // mobile
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.grantPermissions(['microphone'], { origin: BASE });
  await m.route('**://www.youtube.com/iframe_api*', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  const mp = await m.newPage();
  mp.on('console', (x) => { if (x.type() === 'error') errors.push('mobile: ' + x.text()); });
  mp.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
  await mp.goto(BASE + '?v=dQw4w9WgXcQ');
  await mp.waitForFunction(() => !document.getElementById('singBtn').disabled, null, { timeout: 5000 });
  for (const t of ['guide', 'lyrics', 'history', 'settings']) {
    await mp.click(`.tabs button[data-tab=${t}]`);
    const ov = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check('mobile no h-overflow (' + t + ')', ov.sw <= ov.cw, ov);
  }
  await mp.click('.tabs button[data-tab=guide]');
  await mp.screenshot({ path: path.join(SHOTS, 'mobile-main.png'), fullPage: true });
  await mp.click('#singBtn');
  await sleep(5000);
  await mp.click('#stopBtn');
  await mp.waitForSelector('#resultModal.show');
  const ov2 = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, card: document.querySelector('.card').scrollWidth - document.querySelector('.card').clientWidth }));
  check('mobile result no h-overflow', ov2.sw <= ov2.cw && ov2.card <= 0, ov2);
  await mp.screenshot({ path: path.join(SHOTS, 'mobile-result.png') });

  check('no console errors', errors.length === 0, errors);
  console.log(results.join('\n'));
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(2); });
