const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTime, parseVideo, formatTime, seoulDate, splitListening, Meter, ResumeGuard, Store, validateBackup, consumePlayTicket, validRate, PREFIX } = require('../drama-bible-resume.user.js');

function memory() {
  const values = new Map();
  return { values, getValue: async (k, fallback = null) => values.has(k) ? structuredClone(values.get(k)) : fallback, setValue: async (k, v) => { values.set(k, structuredClone(v)); }, listValues: async () => [...values.keys()] };
}
const ID = 'jVO5lOOS37w';
function sample(now, position, extra = {}) { return { now, position, valid: true, seeking: false, playing: true, rate: 1, ...extra }; }

test('YouTube links are allowlisted and tracking parameters are discarded', () => {
  assert.deepEqual(parseVideo(`https://m.youtube.com/watch?v=${ID}&t=1m30s&pp=tracking`), { id: ID, position: 90 });
  assert.equal(parseVideo(`https://youtu.be/${ID}?t=2h3m4s`).position, 7384);
  for (const url of [`https://youtube.com.evil.test/watch?v=${ID}`, `javascript:alert(1)`, `https://youtube.com/playlist?list=${ID}`, `https://youtube.com/watch?v=bad`]) assert.throws(() => parseVideo(url));
});
test('Time entry accepts seconds and clock notation, rejects malformed input', () => {
  for (const [input, value] of [['1:23', 83], ['1:02:03', 3723], ['45s', 45], ['2m', 120], ['', null], ['-1', null], ['2:99', null], ['hello', null]]) assert.equal(parseTime(input), value);
  assert.equal(formatTime(3723.99), '1:02:03');
  assert.equal(parseTime('9'.repeat(400) + ':00'), null);
});
test('Listening uses elapsed playback and excludes forward/backward seeks, ads and buffering', () => {
  const meter = new Meter();
  assert.equal(meter.observe(sample(1000, 10)), 0);
  assert.equal(meter.observe(sample(2000, 11)), 1);
  assert.equal(meter.observe(sample(3000, 100)), 0);
  assert.equal(meter.observe(sample(4000, 20, { seeking: true })), 0);
  assert.equal(meter.observe(sample(5000, 21)), 0);
  assert.equal(meter.observe(sample(6000, 22, { valid: false })), 0);
  assert.equal(meter.observe(sample(7000, 23)), 0);
  assert.equal(meter.observe(sample(8000, 23, { playing: false })), 0);
  assert.equal(meter.observe(sample(9000, 24)), 0);
});
test('Playback speed, pause tail and long unobserved gaps are handled conservatively', () => {
  const meter = new Meter(); meter.observe(sample(0, 0, { rate: 2 }));
  assert.equal(meter.observe(sample(1000, 2, { rate: 2 })), 1);
  assert.equal(meter.observe(sample(2000, 4, { rate: 2, playing: false })), 1);
  meter.observe(sample(3000, 4));
  assert.equal(meter.observe(sample(40000, 41)), 0);
});
test('Seoul midnight splits listening between the correct dates', () => {
  const now = Date.parse('2026-01-02T15:00:02Z');
  assert.equal(seoulDate(now), '2026-01-03');
  assert.deepEqual(splitListening(now, 5).map(({ date, seconds }) => ({ date, seconds })), [{ date: '2026-01-02', seconds: 3 }, { date: '2026-01-03', seconds: 2 }]);
});
test('Initial link position is set once; rewinds persist rather than the furthest position', async () => {
  const gm = memory(); let count = 0;
  const store = new Store(gm, () => 100, () => `owner-${++count}`);
  await store.addVideo(ID, '사도행전', 90);
  await store.addVideo(ID, '기존 제목 유지', 0);
  assert.equal((await store.progress(ID)).position, 90);
  const token = await store.claim(ID);
  await store.savePosition(ID, token, { position: 150, duration: 900, completed: false });
  await store.savePosition(ID, token, { position: 60, duration: 900, completed: false });
  const reopened = new Store(gm);
  assert.equal((await reopened.progress(ID)).position, 60);
});
test('Video progress is independent; late old-tab writes cannot replace the current owner', async () => {
  const gm = memory(); let count = 0;
  const a = new Store(gm, () => 100, () => `token-${++count}`);
  const b = new Store(gm, () => 200, () => `token-${++count}`);
  await a.addVideo(ID, '사도행전', 30); await a.addVideo('T1Z4eTqGmVQ', '레위기', 4);
  const old = await a.claim(ID);
  await a.savePosition(ID, old, { position: 60, duration: 900, completed: false });
  const current = await b.claim(ID);
  await b.savePosition(ID, current, { position: 80, duration: 900, completed: false });
  assert.equal(await a.savePosition(ID, old, { position: 65, duration: 900, completed: false }), false);
  // Simulate an already-in-flight old write that passed its ownership check before takeover.
  await a.set(`position:${ID}:${old}`, { position: 66 });
  assert.equal((await a.progress(ID)).position, 80);
  assert.equal((await a.progress('T1Z4eTqGmVQ')).position, 4);
});
test('Backup roundtrip merges without duplicates and preserves newer local progress', async () => {
  const first = new Store(memory(), () => 100, () => 'first');
  await first.addVideo(ID, '사도행전', 0); const owner = await first.claim(ID);
  await first.savePosition(ID, owner, { position: 70, duration: 900, completed: false });
  await first.set('session:first:2026-01-02', { id: 'first', videoId: ID, date: '2026-01-02', startPosition: 60, endPosition: 70, listenedSeconds: 10, updatedAt: 100, startedAt: 90 });
  const backup = await first.exportBackup();
  const second = new Store(memory(), () => 200, () => 'second');
  await second.importBackup(backup); await second.importBackup(backup);
  assert.equal((await second.progress(ID)).position, 70);
  assert.equal((await second.entries('session:')).length, 1);
  const next = await second.claim(ID);
  await second.savePosition(ID, next, { position: 85, duration: 900, completed: false });
  await second.importBackup(backup);
  assert.equal((await second.progress(ID)).position, 85);
});
test('Invalid backups are fully rejected before any storage write', async () => {
  const gm = memory(), store = new Store(gm);
  const invalid = { format: 'drama-bible-resume', version: 1, videos: [{ id: ID, title: '정상', initialPosition: 0, addedAt: 0 }], progress: [], sessions: [{ id: '../bad' }] };
  await assert.rejects(store.importBackup(invalid)); assert.equal(gm.values.size, 0);
  invalid.sessions = []; invalid.progress = [{ videoId: ID, position: Infinity, duration: 0, updatedAt: 0, completed: false }];
  assert.throws(() => validateBackup(invalid));
  invalid.progress = []; invalid.videos.push({ ...invalid.videos[0] });
  assert.throws(() => validateBackup(invalid));
});
test('Resume protection preserves its initial anchor across scrubs until measured listening confirms it', () => {
  const guard = new ResumeGuard();
  guard.seek(2400, 600, 10, 'jump-1'); guard.observe(20, 620);
  guard.seek(620, 300, 20, 'jump-2');
  assert.equal(guard.snapshot(300, 4200, false).position, 2400);
  guard.observe(29, 329); assert.ok(guard.pending);
  guard.observe(1, 330); assert.equal(guard.snapshot(330, 4200, false).position, 330);
});

test('Backup preserves recovery points and unconfirmed moves, and accepts legacy files', async () => {
  let n = 0; const first = new Store(memory(), () => 200, () => `source-${++n}`);
  await first.addVideo(ID, '사도행전', 90); const owner = await first.claim(ID);
  const guard = new ResumeGuard(); guard.seek(90, 20, 200, 'jump-1');
  await first.checkpoint(ID, 90, 20);
  await first.savePosition(ID, owner, guard.snapshot(20, 900, false));
  const backup = await first.exportBackup();
  const next = new Store(memory(), () => 300, () => `target-${++n}`);
  await next.importBackup(backup); await next.importBackup(backup);
  assert.equal((await next.progress(ID)).pending.position, 20);
  assert.equal((await next.entries('checkpoint:')).length, 1);
  assert.ok((await next.recoverable(ID)).some((p) => p.position === 90));
  const legacy = structuredClone(backup); delete legacy.checkpoints; delete legacy.progress[0].pending;
  assert.doesNotThrow(() => validateBackup(legacy));
  backup.progress[0].pending.fromPosition = 80;
  const badStore = new Store(memory()); await assert.rejects(badStore.importBackup(backup));
  assert.equal((await badStore.gm.listValues()).length, 0);
});

test('A failed recovery write keeps the original progress protected even after thirty seconds', () => {
  const guard = new ResumeGuard(); guard.seek(90, 20, 100, 'failed-point');
  guard.observe(30, 50, false);
  assert.equal(guard.snapshot(50, 900, false).position, 90);
  assert.equal(guard.pending.listenedSeconds, 30);
});

test('Speed preferences survive backup restoration and reject invalid speeds before writes', async () => {
  const source = new Store(memory()); await source.addVideo(ID, '사도행전'); await source.set('playbackRate', 1.75);
  const backup = await source.exportBackup(); const target = new Store(memory());
  await target.importBackup(backup); assert.equal(await target.get('playbackRate'), 1.75);
  backup.settings.playbackRate = 0;
  const invalid = new Store(memory()); await assert.rejects(invalid.importBackup(backup));
  assert.equal((await invalid.gm.listValues()).length, 0);
  for (const rate of [NaN, Infinity, -1, 0, 5, '1.5']) assert.equal(validRate(rate), false);
});

test('Navigation play tickets require matching video and nonce, expire, and are consumed once', () => {
  const data = new Map();
  const win = { sessionStorage: { getItem: (k) => data.get(k), removeItem: (k) => data.delete(k) } };
  const write = () => data.set('dbr:play-ticket', JSON.stringify({ id: ID, nonce: 'once', at: 100 }));
  write(); assert.equal(consumePlayTicket(win, `https://m.youtube.com/watch?v=${ID}&dbr_play=wrong`, 200), null);
  assert.equal(consumePlayTicket(win, `https://m.youtube.com/watch?v=${ID}&dbr_play=once`, 200), ID);
  assert.equal(consumePlayTicket(win, `https://m.youtube.com/watch?v=${ID}&dbr_play=once`, 201), null);
  write(); assert.equal(consumePlayTicket(win, `https://m.youtube.com/watch?v=${ID}&dbr_play=once`, 30101), null);
});
