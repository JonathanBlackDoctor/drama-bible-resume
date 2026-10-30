const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { startApp, inspectPlayer } = require('../drama-bible-resume.user.js');
const ID = 'jVO5lOOS37w';
function memory() { const data = new Map(); return { getValue: async (key, fallback = null) => data.has(key) ? structuredClone(data.get(key)) : fallback, setValue: async (key, value) => { data.set(key, structuredClone(value)); }, listValues: async () => [...data.keys()] }; }
async function fixture(t, options = {}) {
  const duration = options.duration || 900;
  const dom = new JSDOM('<!doctype html><html><body><div id="movie_player"><video class="html5-main-video"></video></div></body></html>', { url: `https://m.youtube.com/watch?v=${ID}&t=${options.position ?? 90}s`, pretendToBeVisual: true });
  const win = dom.window, doc = win.document, player = doc.getElementById('movie_player');
  let currentId = ID, clock = Date.parse('2026-01-02T01:00:00Z'), n = 0;
  player.getVideoData = () => ({ video_id: currentId, title: '테스트 영상' });
  player.getPlayerResponse = () => ({ videoDetails: { videoId: currentId, lengthSeconds: String(duration), title: '테스트 영상' } });
  const video = player.querySelector('video');
  for (const [key, value] of Object.entries({ duration, currentTime: 0, paused: true, ended: false, readyState: 4, seeking: false, playbackRate: 1 })) Object.defineProperty(video, key, { configurable: true, writable: true, value });
  video.play = () => { video.paused = false; video.dispatchEvent(new win.Event('play')); return Promise.resolve(); };
  video.pause = () => { video.paused = true; video.dispatchEvent(new win.Event('pause')); };
  const gm = options.gm || memory();
  const app = await startApp({ window: win, document: doc, page: win, gm, now: () => clock, uuid: () => `${options.prefix || 'tab'}-${++n}` });
  const settle = async () => { await Promise.resolve(); await app.idle(); };
  const seeked = async () => { video.dispatchEvent(new win.Event('seeked')); await settle(); };
  const tick = async (seconds = 1) => { clock += seconds * 1000; if (!video.paused) video.currentTime += seconds * video.playbackRate; await app.reconcile(); await settle(); };
  const click = (selector) => app.root.querySelector(selector).click();
  const seek = async (position) => { video.seeking = true; video.dispatchEvent(new win.Event('seeking')); video.currentTime = position; video.seeking = false; await seeked(); };
  t.after(() => { app.destroy(); dom.window.close(); });
  return { app, win, doc, player, video, gm, settle, seeked, seek, tick, click, setId: (id) => { currentId = id; } };
}

test('Initial restoration never overwrites saved progress with startup zero', async (t) => {
  const f = await fixture(t); assert.equal(f.video.currentTime, 90);
  await f.seeked(); await f.tick(4);
  assert.equal((await f.app.store.progress(ID)).position, 90);
  assert.match(f.app.root.querySelector('#position').textContent, /1:30/);
});
test('One resume tap plays, records actual listening, and pause flushes the final position', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle();
  assert.equal(f.video.paused, false);
  await f.tick(); await f.tick(); await f.tick();
  f.video.pause(); await f.settle();
  assert.equal((await f.app.store.progress(ID)).position, 93);
  const sessions = await f.app.store.entries('session:');
  assert.equal(sessions[0].listenedSeconds, 3);
  f.click('.secondary'); await f.settle();
  assert.match(f.app.root.querySelector('#history').textContent, /2026-01-02/);
});
test('Advertising duration, ad classes and wrong player ID are rejected', async (t) => {
  const f = await fixture(t);
  const inspect = () => inspectPlayer(f.doc, f.win, ID);
  assert.equal(inspect().valid, true);
  f.player.classList.add('ad-showing'); assert.equal(inspect().valid, false);
  f.player.classList.remove('ad-showing'); f.video.duration = 30; assert.equal(inspect().valid, false);
  f.video.duration = 900; f.setId('T1Z4eTqGmVQ'); assert.equal(inspect().valid, false);
});
test('Advertisements cannot overwrite content position or add listening time', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle();
  await f.tick(); await f.tick(); await f.tick(); await f.app.flush();
  const before = await f.app.store.progress(ID);
  f.player.classList.add('ad-showing'); f.video.currentTime = 0;
  await f.tick(5); await f.app.flush();
  assert.equal((await f.app.store.progress(ID)).position, before.position);
  f.player.classList.remove('ad-showing'); f.video.currentTime = before.position;
  await f.tick(); await f.tick(); f.video.pause(); await f.settle();
  const listened = (await f.app.store.entries('session:')).reduce((sum, s) => sum + s.listenedSeconds, 0);
  assert.ok(listened <= 5, `Unexpected listening credit: ${listened}`);
});
test('Accidental rewinds preserve the original resume point and do not count the skipped interval', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle();
  await f.tick(); await f.tick();
  f.video.seeking = true; f.video.dispatchEvent(new f.win.Event('seeking'));
  f.video.currentTime = 20; f.video.seeking = false; await f.seeked();
  f.video.pause(); await f.settle();
  assert.equal((await f.app.store.progress(ID)).position, 92);
  assert.equal((await f.app.store.progress(ID)).pending.position, 20);
  assert.ok((await f.app.store.entries('session:')).reduce((n, s) => n + s.listenedSeconds, 0) <= 2);
});
test('SPA URL transitions never write an old player into another video', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle(); await f.tick();
  await f.app.store.addVideo('T1Z4eTqGmVQ', '레위기', 12);
  f.win.history.pushState({}, '', '/watch?v=T1Z4eTqGmVQ'); await f.app.reconcile();
  assert.equal((await f.app.store.progress('T1Z4eTqGmVQ')).position, 12);
  assert.equal(inspectPlayer(f.doc, f.win, 'T1Z4eTqGmVQ').valid, false);
});
test('Adding a link preserves timestamps and renders user text without HTML execution', async (t) => {
  const f = await fixture(t); f.click('.secondary'); await f.settle();
  f.app.root.querySelector('#url').value = 'https://youtu.be/T1Z4eTqGmVQ?t=45s';
  f.app.root.querySelector('#video-title').value = '<img src=x onerror=alert(1)>';
  f.app.root.querySelector('#add').dispatchEvent(new f.win.Event('submit', { bubbles: true, cancelable: true })); await f.settle();
  assert.equal((await f.app.store.progress('T1Z4eTqGmVQ')).position, 45);
  assert.equal(f.app.root.querySelector('#library img'), null);
  assert.match(f.app.root.querySelector('#library').textContent, /<img/);
});
test('Playback rejection is explained without falsely claiming playback started', async (t) => {
  const f = await fixture(t); await f.seeked();
  f.video.play = () => Promise.reject(new Error('NotAllowedError'));
  f.click('.primary'); await f.settle(); await new Promise((resolve) => setImmediate(resolve));
  assert.match(f.app.root.querySelector('.status').textContent, /▶ 버튼/);
  assert.equal(f.video.paused, true);
});

test('Hidden ad nodes do not block content, while missing player evidence fails closed', async (t) => {
  const f = await fixture(t);
  const overlay = f.doc.createElement('div'); overlay.className = 'ytp-ad-player-overlay'; overlay.style.display = 'none'; f.player.append(overlay);
  assert.equal(inspectPlayer(f.doc, f.win, ID).valid, true);
  f.player.getPlayerResponse = () => null;
  assert.equal(inspectPlayer(f.doc, f.win, ID).valid, false);
});

test('Manual position editing persists without counting the seek or deadlocking pause writes', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle(); await f.tick();
  f.click('.secondary'); await f.settle();
  f.app.root.querySelector('#time').value = '0:30';
  f.app.root.querySelector('#edit').dispatchEvent(new f.win.Event('submit', { bubbles: true, cancelable: true }));
  await f.settle(); await f.seeked();
  assert.equal((await f.app.store.progress(ID)).position, 30);
  assert.equal(f.video.paused, true);
});

test('Ending the content saves completion and invites the user to choose the next video', async (t) => {
  const f = await fixture(t, { position: 899 }); await f.seeked(); f.click('.primary'); await f.settle(); await f.tick();
  f.video.currentTime = 900; f.video.ended = true; f.video.paused = true;
  f.video.dispatchEvent(new f.win.Event('ended')); await f.settle();
  assert.equal((await f.app.store.progress(ID)).completed, true);
  assert.match(f.app.root.querySelector('.status').textContent, /완주/);
});

test('A thirty-minute accidental rewind keeps the original resume point even after pause', async (t) => {
  const f = await fixture(t, { duration: 4200, position: 2400 });
  await f.seeked(); f.click('.primary'); await f.settle(); await f.tick(3);
  await f.seek(603); f.video.pause(); await f.settle();
  const saved = await f.app.store.progress(ID);
  assert.equal(saved.position, 2403); assert.equal(saved.pending.position, 603);
  assert.equal(f.app.root.querySelector('.safety').hidden, false);
  const points = await f.app.store.entries(`checkpoint:${ID}:`);
  assert.equal(points[0].fromPosition, 2403); assert.equal(points[0].toPosition, 603);
  f.click('#undo-seek'); await f.settle();
  assert.equal(f.video.currentTime, 2403);
  assert.equal((await f.app.store.progress(ID)).pending, null);
});

test('Only thirty actual playback seconds confirm a new location, with the old point still recoverable', async (t) => {
  const f = await fixture(t, { duration: 4200, position: 2400 });
  await f.seeked(); f.click('.primary'); await f.settle(); await f.tick(3); await f.seek(600);
  await f.tick(29); assert.equal((await f.app.store.progress(ID)).position, 2403);
  await f.tick(); assert.equal((await f.app.store.progress(ID)).position, 630);
  f.click('.secondary'); await f.settle();
  const button = [...f.app.root.querySelectorAll('#recovery button')].find((b) => b.textContent.includes('구간 이동 전') && b.textContent.includes('40:03'));
  assert.ok(button); button.click(); await f.settle();
  assert.equal((await f.app.store.progress(ID)).position, 2403);
});

test('Waiting on a paused or buffering candidate never confirms it', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle(); await f.tick(3); await f.seek(20);
  f.video.pause(); await f.settle(); await f.tick(60);
  const saved = await f.app.store.progress(ID);
  assert.equal(saved.position, 93); assert.equal(saved.pending.listenedSeconds, 0);
});

test('After restart an unconfirmed rewind restores the protected position without memorizing it', async (t) => {
  const f = await fixture(t, { duration: 4200, position: 2400 });
  await f.seeked(); f.click('.primary'); await f.settle(); await f.tick(3); await f.seek(600); await f.tick(4);
  f.video.pause(); await f.settle(); f.app.destroy();
  const next = await fixture(t, { duration: 4200, position: 0, gm: f.gm, prefix: 'restart' });
  assert.equal(next.video.currentTime, 2403);
  await next.seeked(); next.click('.primary'); await next.settle(); await next.tick();
  assert.equal((await next.app.store.progress(ID)).position, 2404);
  assert.equal((await next.app.store.progress(ID)).pending, null);
  assert.equal((await next.app.store.entries(`checkpoint:${ID}:`)).length, 1);
});

test('An intentional move can be explicitly confirmed without waiting thirty seconds', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle(); await f.tick(); await f.seek(20);
  f.click('#accept-seek'); await f.settle();
  const saved = await f.app.store.progress(ID);
  assert.equal(saved.position, 20); assert.equal(saved.pending, null);
  assert.ok((await f.app.store.recoverable(ID)).some((p) => p.position === 91));
});

test('A paused seek before first playback is also protected', async (t) => {
  const f = await fixture(t); await f.seeked(); await f.seek(10); await f.settle();
  const saved = await f.app.store.progress(ID);
  assert.equal(saved.position, 90); assert.equal(saved.pending.position, 10);
});

test('Multiple accidental scrubs keep the original protected point and all move records', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle(); await f.tick(3);
  await f.seek(20); await f.tick(5); await f.seek(40); await f.tick(5); f.video.pause(); await f.settle();
  assert.equal((await f.app.store.progress(ID)).position, 93);
  assert.equal((await f.app.store.entries(`checkpoint:${ID}:`)).length, 2);
  f.click('#undo-seek'); await f.settle(); assert.equal(f.video.currentTime, 93);
});

test('Legacy playback records offer a one-click restore button after updating', async (t) => {
  const f = await fixture(t); await f.seeked();
  await f.app.store.set('session:legacy:2026-01-01', { id: 'legacy', videoId: ID, date: '2026-01-01', startPosition: 100, endPosition: 250, listenedSeconds: 150, startedAt: 1000, updatedAt: 151000 });
  f.click('.secondary'); await f.settle();
  const button = [...f.app.root.querySelectorAll('#recovery button')].find((b) => b.textContent.includes('재생 기록') && b.textContent.includes('4:10'));
  assert.ok(button); button.click(); await f.settle();
  assert.equal((await f.app.store.progress(ID)).position, 250);
});

test('A silent playback discontinuity without seek events cannot replace the saved point', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle(); await f.tick(3);
  f.video.currentTime = 10; await f.tick(); await f.app.flush(); await f.settle();
  assert.equal((await f.app.store.progress(ID)).position, 93);
  assert.equal((await f.app.store.entries(`checkpoint:${ID}:`)).length, 1);
});

test('Seeking directly to the end does not falsely complete the protected original progress', async (t) => {
  const f = await fixture(t); await f.seeked(); f.click('.primary'); await f.settle(); await f.tick(3); await f.seek(900);
  f.video.ended = true; f.video.paused = true; f.video.dispatchEvent(new f.win.Event('ended')); await f.settle();
  const saved = await f.app.store.progress(ID);
  assert.equal(saved.position, 93); assert.equal(saved.completed, false);
});
