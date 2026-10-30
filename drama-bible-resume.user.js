// ==UserScript==
// @name         드라마바이블 이어듣기
// @namespace    https://github.com/JonathanBlackDoctor/drama-bible-resume
// @version      1.0.0
// @description  마지막 위치부터 성경을 듣고, 날짜별 청취 기록을 내 기기에 보관합니다.
// @author       JonathanBlackDoctor
// @license      MIT
// @match        https://m.youtube.com/*
// @match        https://www.youtube.com/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        unsafeWindow
// @inject-into  content
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/JonathanBlackDoctor/drama-bible-resume
// @downloadURL  https://raw.githubusercontent.com/JonathanBlackDoctor/drama-bible-resume/main/drama-bible-resume.user.js
// @updateURL    https://raw.githubusercontent.com/JonathanBlackDoctor/drama-bible-resume/main/drama-bible-resume.user.js
// ==/UserScript==

(function () {
  'use strict';
  const PREFIX = 'dbr:v1:';
  const DEFAULT_VIDEO = { id: 'jVO5lOOS37w', title: '사도행전 · 전체 통독' };
  const VIDEO_ID = /^[\w-]{11}$/;
  const TOKEN = /^[\w-]{1,100}$/;
  const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
  const SEOUL = 9 * 3600 * 1000;
  const DAY = 24 * 3600 * 1000;
  const copy = (value) => JSON.parse(JSON.stringify(value));

  function parseTime(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    const text = String(value ?? '').trim();
    if (/^\d+(?:\.\d+)?s?$/.test(text)) { const n = Number(text.replace(/s$/, '')); return Number.isFinite(n) && n <= 1e12 ? n : null; }
    if (/^\d+(?::[0-5]\d){1,2}$/.test(text)) return text.split(':').reduce((n, part) => n * 60 + Number(part), 0);
    const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
    return units && text ? Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0) : null;
  }

  function parseVideo(input) {
    let url;
    try { url = new URL(input); } catch { throw new Error('유튜브 영상 링크를 입력해 주세요.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('유튜브 영상 링크만 사용할 수 있습니다.');
    let id;
    if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) && url.pathname === '/watch') id = url.searchParams.get('v');
    if (!VIDEO_ID.test(id || '')) throw new Error('watch?v= 또는 youtu.be 형식의 영상 링크를 넣어 주세요.');
    return { id, position: parseTime(url.searchParams.get('t') ?? url.searchParams.get('start')) ?? 0 };
  }

  function formatTime(value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    const seconds = String(n % 60).padStart(2, '0');
    const minutes = Math.floor(n / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
  }

  const seoulDate = (timestamp) => new Date(timestamp + SEOUL).toISOString().slice(0, 10);
  function splitListening(now, seconds) {
    const parts = [];
    let cursor = now - seconds * 1000;
    while (cursor < now - 0.001) {
      const until = Math.min(now, (Math.floor((cursor + SEOUL) / DAY) + 1) * DAY - SEOUL);
      parts.push({ date: seoulDate(cursor), seconds: (until - cursor) / 1000, endAt: until });
      cursor = until;
    }
    return parts;
  }

  // Count elapsed listening, never time skipped by seeking. Long unobserved gaps fail closed.
  class Meter {
    constructor() { this.previous = null; }
    reset() { this.previous = null; }
    observe(sample) {
      const previous = this.previous;
      this.previous = sample.valid && !sample.seeking ? { ...sample } : null;
      if (!previous || !sample.valid || sample.seeking || !previous.playing) return 0;
      const elapsed = (sample.now - previous.now) / 1000;
      const advanced = sample.position - previous.position;
      const rate = previous.rate || 1;
      if (elapsed <= 0 || elapsed > 30 || advanced < 0 || advanced > elapsed * rate + 0.75) return 0;
      return Math.max(0, Math.min(elapsed, advanced / rate));
    }
  }

  function validateBackup(raw) {
    const bad = () => { throw new Error('백업 형식이 올바르지 않습니다. 기존 기록은 변경하지 않았습니다.'); };
    const finite = (n, max = 1e12) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
    if (!raw || raw.format !== 'drama-bible-resume' || raw.version !== 1 || !Array.isArray(raw.videos) || !Array.isArray(raw.progress) || !Array.isArray(raw.sessions)) bad();
    if (raw.videos.length > 1000 || raw.progress.length > 1000 || raw.sessions.length > 20000) bad();
    const ids = new Set();
    const videos = raw.videos.map((v) => {
      if (!v || !VIDEO_ID.test(v.id) || ids.has(v.id) || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 200 || !finite(v.initialPosition) || !finite(v.addedAt, 9e15)) bad();
      ids.add(v.id);
      return { id: v.id, title: v.title, initialPosition: v.initialPosition, addedAt: v.addedAt };
    });
    const seenProgress = new Set();
    const progress = raw.progress.map((p) => {
      if (!p || !ids.has(p.videoId) || seenProgress.has(p.videoId) || !finite(p.position) || !finite(p.duration) || !finite(p.updatedAt, 9e15) || typeof p.completed !== 'boolean' || (p.duration > 0 && p.position > p.duration + 2)) bad();
      seenProgress.add(p.videoId);
      return { videoId: p.videoId, position: p.position, duration: p.duration, updatedAt: p.updatedAt, completed: p.completed };
    });
    const seenSessions = new Set();
    const sessions = raw.sessions.map((s) => {
      if (!s || !TOKEN.test(s.id) || !ids.has(s.videoId) || !/^\d{4}-\d\d-\d\d$/.test(s.date) || !finite(s.startPosition) || !finite(s.endPosition) || !finite(s.listenedSeconds, 86400) || !finite(s.updatedAt, 9e15) || !finite(s.startedAt, 9e15)) bad();
      const day = new Date(`${s.date}T00:00:00Z`);
      if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== s.date || seenSessions.has(`${s.id}:${s.date}`)) bad();
      seenSessions.add(`${s.id}:${s.date}`);
      return { id: s.id, videoId: s.videoId, date: s.date, startPosition: s.startPosition, endPosition: s.endPosition, listenedSeconds: s.listenedSeconds, updatedAt: s.updatedAt, startedAt: s.startedAt };
    });
    return { videos, progress, sessions };
  }

  class Store {
    constructor(gm, now = Date.now, uuid = () => crypto.randomUUID()) {
      this.gm = gm; this.now = now; this.uuid = uuid;
    }
    get(key, fallback = null) { return this.gm.getValue(PREFIX + key, fallback); }
    set(key, value) { return this.gm.setValue(PREFIX + key, copy(value)); }
    async entries(kind) {
      const keys = (await this.gm.listValues()).filter((key) => key.startsWith(PREFIX + kind));
      return Promise.all(keys.map((key) => this.gm.getValue(key)));
    }
    async videos() { return (await this.entries('video:')).filter(Boolean).sort((a, b) => a.addedAt - b.addedAt); }
    async addVideo(id, title, position = 0) {
      const existing = await this.get(`video:${id}`);
      if (existing) return existing;
      const video = { id, title: title.trim().slice(0, 200) || '성경 통독 영상', initialPosition: position, addedAt: this.now() };
      await this.set(`video:${id}`, video);
      return video;
    }
    async progress(id) {
      const owner = await this.get(`owner:${id}`);
      if (owner) return await this.get(`position:${id}:${owner.token}`, owner.seed);
      const video = await this.get(`video:${id}`);
      return { videoId: id, position: video?.initialPosition || 0, duration: 0, completed: false, updatedAt: 0 };
    }
    async claim(id) {
      const seed = await this.progress(id);
      const token = this.uuid();
      // Each owner has its own position key: a delayed old tab cannot overwrite the new tab.
      await this.set(`position:${id}:${token}`, seed);
      await this.set(`owner:${id}`, { token, seed });
      await this.set('last', id);
      return token;
    }
    async owns(id, token) { return (await this.get(`owner:${id}`))?.token === token; }
    async savePosition(id, token, progress) {
      if (!await this.owns(id, token)) return false;
      await this.set(`position:${id}:${token}`, { videoId: id, ...progress, updatedAt: this.now() });
      return true;
    }
    async exportBackup() {
      const videos = await this.videos();
      const progress = await Promise.all(videos.map((video) => this.progress(video.id)));
      const sessions = (await this.entries('session:')).filter(Boolean);
      return { format: 'drama-bible-resume', version: 1, exportedAt: new Date(this.now()).toISOString(), videos, progress, sessions };
    }
    async importBackup(raw) {
      const backup = validateBackup(raw); // Validate the entire file BEFORE the first write.
      for (const video of backup.videos) {
        if (!await this.get(`video:${video.id}`)) await this.set(`video:${video.id}`, video);
      }
      for (const progress of backup.progress) {
        if ((await this.progress(progress.videoId)).updatedAt < progress.updatedAt) {
          const token = this.uuid();
          await this.set(`position:${progress.videoId}:${token}`, progress);
          await this.set(`owner:${progress.videoId}`, { token, seed: progress });
        }
      }
      for (const session of backup.sessions) {
        const key = `session:${session.id}:${session.date}`;
        const existing = await this.get(key);
        if (!existing || existing.updatedAt < session.updatedAt) await this.set(key, session);
      }
      return backup;
    }
  }

  // A player-owned ID AND matching content duration are required. Page URL alone is unsafe.
  function inspectPlayer(doc, page, urlId) {
    try {
      const player = page.document.getElementById('movie_player') || page.document.querySelector('.html5-video-player');
      const element = doc.getElementById('movie_player') || doc.querySelector('.html5-video-player');
      const video = element?.querySelector('video.html5-main-video') || element?.querySelector('video');
      if (!player || !element || !video) return { valid: false, video, reason: '유튜브 플레이어를 기다리는 중' };
      const overlay = element.querySelector('.ytp-ad-player-overlay, .ytp-ad-text:not([hidden])');
      const visibleAd = overlay && overlay.getClientRects().length > 0 && doc.defaultView.getComputedStyle(overlay).visibility !== 'hidden';
      if (element.matches('.ad-showing, .ad-interrupting') || visibleAd) return { valid: false, video, reason: '광고 중 · 기록 잠시 멈춤' };
      const data = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
      const response = typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
      const identity = data?.video_id || response?.videoDetails?.videoId;
      const details = response?.videoDetails || (page.ytInitialPlayerResponse?.videoDetails?.videoId === identity ? page.ytInitialPlayerResponse.videoDetails : null);
      const duration = Number(details?.lengthSeconds);
      if (identity !== urlId || details?.videoId !== urlId || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(video.duration) || Math.abs(video.duration - duration) > 2 || video.readyState < 1) {
        return { valid: false, video, reason: '본영상 확인 중 · 기록 대기' };
      }
      return { valid: true, video, duration: video.duration, title: String(data?.title || details.title || ''), position: video.currentTime };
    } catch { return { valid: false, video: null, reason: '영상 정보를 확인할 수 없어 기록 대기' }; }
  }

  const CSS = `
    :host{all:initial;color-scheme:light;font:14px/1.5 system-ui,-apple-system,"Noto Sans KR",sans-serif;color:#233b36}
    *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer;min-height:46px;border:1px solid #d9e4dd;border-radius:13px;padding:9px 13px;background:#fff;color:#233b36}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #d58c37;outline-offset:2px}button:hover{background:#edf4ee}button:disabled{opacity:.5;cursor:wait}
    .shell{position:fixed;z-index:2147483646;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));width:min(410px,calc(100vw - 24px));background:#fffdf6;border:1px solid #dce5d9;border-radius:23px;box-shadow:0 8px 36px #102c2933;overflow:hidden}
    .head{display:flex;align-items:center;gap:10px;padding:14px 17px 4px}.brand{font-size:11px;letter-spacing:.12em;font-weight:700;color:#60796c}.close{margin-left:auto;border:0;background:none;padding:0;min-height:32px;width:32px}.body{padding:0 17px 16px}h2{font-size:18px;letter-spacing:-.03em;margin:2px 0 5px}p{margin:5px 0}.muted{color:#64776d;font-size:12px}.progress{height:5px;background:#e5ecdf;border-radius:6px;margin:12px 0}.bar{height:100%;background:#57866b;border-radius:6px;width:0}.row{display:flex;gap:8px;align-items:center}.row>*{min-width:0}.primary{flex:1;background:#254f41;color:white;border-color:#254f41;font-weight:700;font-size:16px}.primary:hover{background:#193e32}.secondary{background:#f1f4e9}.status{min-height:19px;margin-top:8px;font-size:12px;color:#596f61}.status.error{color:#a13c25}.drawer{border-top:1px solid #dce5d9;padding:13px 17px;max-height:52vh;overflow-y:auto;overscroll-behavior:contain}h3{font-size:14px;margin:0 0 8px}label{display:block;font-size:12px;color:#50695c;margin:7px 0 3px}input{min-height:46px;border:1px solid #ccd8cb;border-radius:10px;width:100%;padding:10px;background:white;color:#233b36}form{margin:10px 0 16px}.video-row,.history-row{padding:10px 0;border-bottom:1px solid #e6ebdf}.video-row button{width:100%;text-align:left}.history-row strong{display:block;font-size:13px}.tools{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.tools button{flex:1;font-size:12px}summary{cursor:pointer;padding:8px 0}.chip{position:fixed;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483646;border-radius:30px;box-shadow:0 3px 15px #102c2933;background:#fffdf6;font-weight:700}.empty{padding:15px 0;color:#687969;font-size:13px}.small{font-size:12px}.count{color:#69816c;font-size:12px;margin-left:7px}[hidden]{display:none!important}
    @media(prefers-reduced-motion:no-preference){.bar{transition:width .3s}}@media(max-height:500px){.drawer{max-height:35vh}.shell{bottom:5px}}
  `;

  async function startApp(env) {
    const { window: win, document: doc, gm, page = win, now = Date.now, uuid = () => win.crypto.randomUUID() } = env;
    const getUrl = env.getUrl || (() => win.location.href);
    if (doc.getElementById('dbr-root')) return null;
    const store = new Store(gm, now, uuid);
    let initial;
    try { initial = parseVideo(getUrl()); } catch { initial = null; }
    await store.addVideo(DEFAULT_VIDEO.id, DEFAULT_VIDEO.title, initial?.id === DEFAULT_VIDEO.id ? initial.position : 0);
    let videos = await store.videos();
    let selected = videos.some((v) => v.id === initial?.id) ? initial.id : await store.get('last', DEFAULT_VIDEO.id);
    if (!videos.some((v) => v.id === selected)) selected = DEFAULT_VIDEO.id;
    let progress = await store.progress(selected);
    let active = null, ownerLost = false, starting = null, queue = Promise.resolve(), destroyed = false;
    let boundVideo = null, boundId = null, restored = false, drawerOpen = false, panelOpen = Boolean(initial && videos.some((v) => v.id === initial.id));
    let lastSave = 0, lastUi = 0, status = '기록은 이 기기에만 보관됩니다.', restoreTarget = null;
    let pendingCredits = [], detailsTask = Promise.resolve(), reconciling = null;
    const meter = new Meter();
    const host = doc.createElement('aside'); host.id = 'dbr-root'; doc.documentElement.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><button class="chip" type="button">📖 성경 듣기</button><section class="shell" aria-label="드라마바이블 이어듣기"><div class="head"><span class="brand">DRAMA BIBLE · 이어듣기</span><button class="close" aria-label="패널 접기" type="button">×</button></div><div class="body"><h2 id="title"></h2><p class="muted" id="position"></p><div class="progress" role="progressbar" aria-label="영상 진도" aria-valuemin="0" aria-valuemax="100"><div class="bar"></div></div><div class="row"><button class="primary" type="button">▶ 이어 듣기</button><button class="secondary" type="button" aria-expanded="false">기록·영상</button></div><p class="status" role="status" aria-live="polite"></p></div><div class="drawer" hidden><h3>내 성경 영상</h3><div id="library"></div><form id="add"><label for="url">다른 성경 영상 추가</label><input id="url" type="url" placeholder="유튜브 영상 링크" required><label for="video-title">영상 이름 (선택)</label><input id="video-title" placeholder="예: 로마서 전체 통독" maxlength="200"><button type="submit" style="margin-top:8px;width:100%">＋ 영상 추가</button></form><details><summary>현재 위치 직접 수정</summary><form id="edit"><label for="time">시:분:초 또는 분:초</label><div class="row"><input id="time" placeholder="0:00" required><button type="submit">저장</button></div><p class="muted">선택한 영상의 다음 시작 위치를 바꿉니다.</p></form></details><div class="tools"><button id="export" type="button">백업 저장</button><button id="import" type="button">백업 가져오기</button><input id="file" type="file" accept=".json,application/json" hidden></div><p class="muted">가져오기는 기존 기록에 합칩니다. 백업에는 개인 청취 기록이 들어 있습니다.</p><h3 style="margin-top:18px">날짜별 청취 기록 <span class="count">서울 시간</span></h3><div id="history"></div><p class="muted">앞뒤로 이동한 구간은 청취 시간에 포함하지 않습니다. 백그라운드 저장은 Android 절전 설정에 따라 늦어질 수 있습니다.</p></div></section>`;
    const $ = (selector) => root.querySelector(selector);
    const label = (value) => { status = value; $('.status').classList.remove('error'); $('.status').textContent = value; };
    const fail = (error) => { label(error?.message || '저장할 수 없습니다. 백업과 확장 권한을 확인해 주세요.'); $('.status').classList.add('error'); };
    const enqueue = (task) => { const result = queue.then(task); queue = result.catch(fail); return result; };
    const currentId = () => { try { return parseVideo(getUrl()).id; } catch { return null; } };
    const evidence = () => inspectPlayer(doc, page, currentId());

    function render() {
      if (destroyed) return;
      $('.chip').hidden = panelOpen; $('.shell').hidden = !panelOpen;
      $('#title').textContent = videos.find((v) => v.id === selected)?.title || '성경 이어듣기';
      const live = evidence();
      const position = active && active.id === selected && live.valid && !ownerLost ? live.position : progress.position;
      const duration = live.valid && currentId() === selected ? live.duration : progress.duration;
      $('#position').textContent = `${formatTime(position)}${duration > 0 ? ` / ${formatTime(duration)}` : '부터 이어 듣기'}${progress.completed ? ' · 완주' : ''}`;
      const percent = duration > 0 ? Math.min(100, position / duration * 100) : 0;
      $('.bar').style.width = `${percent}%`; $('.progress').setAttribute('aria-valuenow', String(Math.round(percent)));
      $('.primary').textContent = live.valid && currentId() === selected && !live.video.paused && active && !ownerLost ? 'Ⅱ 일시정지' : '▶ 이어 듣기';
      $('.status').textContent = status;
    }

    async function renderDetails() {
      $('#library').replaceChildren();
      for (const video of videos) {
        const saved = await store.progress(video.id);
        const row = doc.createElement('div'); row.className = 'video-row';
        const button = doc.createElement('button'); button.type = 'button';
        button.textContent = `${video.id === selected ? '✓ ' : ''}${video.title} · ${formatTime(saved.position)}${saved.completed ? ' · 완주' : ''}`;
        button.addEventListener('click', () => enqueue(async () => { selected = video.id; progress = await store.progress(selected); render(); await renderDetails(); }));
        row.append(button); $('#library').append(row);
      }
      $('#history').replaceChildren();
      const sessions = (await store.entries('session:')).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
      const groups = new Map();
      for (const session of sessions) {
        const key = `${session.date}:${session.videoId}`;
        if (!groups.has(key)) groups.set(key, { ...session, endAt: session.updatedAt, listenedSeconds: 0 });
        const group = groups.get(key); group.listenedSeconds += session.listenedSeconds;
        if (session.startedAt < group.startedAt) { group.startedAt = session.startedAt; group.startPosition = session.startPosition; }
      }
      for (const session of [...groups.values()].slice(0, 60)) {
        const row = doc.createElement('div'); row.className = 'history-row';
        const title = doc.createElement('strong'); title.textContent = `${session.date} · ${videos.find((v) => v.id === session.videoId)?.title || '성경 영상'}`;
        const text = doc.createElement('p'); text.className = 'muted'; text.textContent = `${formatTime(session.startPosition)} → ${formatTime(session.endPosition)} · ${formatTime(session.listenedSeconds)} 청취`;
        row.append(title, text); $('#history').append(row);
      }
      if (!groups.size) { const empty = doc.createElement('p'); empty.className = 'empty'; empty.textContent = '듣기 시작하면 오늘의 기록이 쌓입니다.'; $('#history').append(empty); }
      $('#time').value = formatTime(progress.position);
    }

    async function begin(id) {
      if (starting) return starting;
      starting = (async () => {
        await queue;
        if (destroyed || currentId() !== id || boundId !== id) return;
        const token = await store.claim(id);
        if (destroyed || currentId() !== id || boundId !== id) return;
        active = { id, token }; ownerLost = false; meter.reset(); pendingCredits = []; lastSave = 0;
        progress = await store.progress(selected);
        label('듣는 중 · 자동 기록'); render();
      })();
      try { await starting; } finally { starting = null; }
    }

    function sample() {
      const current = evidence();
      if (!active || ownerLost || currentId() !== active.id) { meter.reset(); return current; }
      const seconds = meter.observe({ now: now(), valid: current.valid, seeking: Boolean(current.video?.seeking), position: current.position ?? 0, rate: current.video?.playbackRate || 1, playing: current.valid && !current.video.paused && !current.video.ended && current.video.readyState >= 2 });
      if (seconds > 0) pendingCredits.push({ at: now(), seconds, position: current.position, rate: current.video.playbackRate || 1 });
      return current;
    }

    function flush(force = false) {
      const current = sample();
      if (!active || ownerLost || !current.valid || currentId() !== active.id || current.video.seeking || restoreTarget !== null) return queue;
      if (!force && now() - lastSave < 3000) return queue;
      lastSave = now();
      const owner = { ...active }, credits = pendingCredits.splice(0);
      const snapshot = { position: current.position, duration: current.duration, completed: Boolean(current.video.ended) };
      return enqueue(async () => {
        if (!await store.savePosition(owner.id, owner.token, snapshot)) {
          if (active?.token === owner.token) { ownerLost = true; meter.reset(); label('다른 탭에서 재생 중입니다. 이어 듣기를 누르면 이 탭으로 전환합니다.'); }
          render(); return;
        }
        const days = new Map();
        for (const credit of credits) {
          const parts = splitListening(credit.at, credit.seconds);
          let cursorPosition = credit.position - credit.seconds * credit.rate;
          for (const part of parts) {
            if (!days.has(part.date)) days.set(part.date, { id: owner.token, videoId: owner.id, date: part.date, startedAt: part.endAt - part.seconds * 1000, startPosition: Math.max(0, cursorPosition), listenedSeconds: 0 });
            const session = days.get(part.date);
            cursorPosition += part.seconds * credit.rate;
            session.endPosition = Math.max(0, cursorPosition); session.listenedSeconds += part.seconds; session.updatedAt = part.endAt;
          }
        }
        for (const [date, part] of days) {
          const key = `session:${owner.token}:${date}`;
          const existing = await store.get(key);
          await store.set(key, existing ? { ...existing, endPosition: part.endPosition, listenedSeconds: existing.listenedSeconds + part.listenedSeconds, updatedAt: part.updatedAt } : part);
        }
        if (selected === owner.id) progress = { videoId: owner.id, ...snapshot, updatedAt: now() };
        label(snapshot.completed ? '완주했습니다. 기록·영상에서 다음 영상을 골라 주세요.' : `저장됨 · ${new Date(now()).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })}`);
        render();
      });
    }

    function handleEvent(event) {
      if (event.type === 'seeking' || event.type === 'ratechange' || event.type === 'waiting') meter.reset();
      if (event.type === 'play' && restored && !active && !ownerLost) begin(boundId).catch(fail);
      if (event.type === 'playing' && restored && !active && !ownerLost) begin(boundId).catch(fail);
      if (event.type === 'seeked') {
        meter.reset();
        if (restoreTarget !== null && Math.abs(boundVideo.currentTime - restoreTarget) <= 2) restoreTarget = null;
      }
      if (event.type === 'pause' || event.type === 'ended' || event.type === 'seeked') flush(true).catch(fail);
      else flush().catch(fail);
    }
    const events = ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'waiting', 'timeupdate'];

    async function reconcileOnce() {
      if (destroyed) return;
      const id = currentId(), current = evidence();
      const registered = videos.some((v) => v.id === id);
      const video = registered ? current.video : null;
      if (boundVideo !== video || boundId !== id) {
        if (boundVideo) for (const type of events) boundVideo.removeEventListener(type, handleEvent);
        // Old-player samples must never be saved under a new URL ID.
        active = null; ownerLost = false; restored = false; restoreTarget = null; meter.reset(); pendingCredits = [];
        boundVideo = video; boundId = id;
        if (registered) { selected = id; progress = await store.progress(id); panelOpen = true; }
        if (video) for (const type of events) video.addEventListener(type, handleEvent);
        render();
      }
      if (registered && current.valid && boundVideo === current.video && !restored) {
        const saved = await store.progress(id);
        if (destroyed || currentId() !== id || boundVideo !== current.video) return;
        restored = true;
        const target = Math.min(saved.position, Math.max(0, current.duration - 0.1));
        if (Math.abs(current.video.currentTime - target) > 1) { restoreTarget = target; current.video.currentTime = target; }
        if (!current.video.paused) await begin(id);
        label(saved.completed ? '완주한 영상입니다. 위치를 바꾸거나 다음 영상을 선택하세요.' : '이어 듣기를 누르면 마지막 위치부터 재생합니다.');
      }
      if (active && !ownerLost && !await store.owns(active.id, active.token)) {
        ownerLost = true; meter.reset(); pendingCredits = []; label('다른 탭에서 재생 중 · 이 탭의 기록은 멈췄습니다.');
      }
      if (ownerLost && selected === active?.id) progress = await store.progress(selected);
      if (registered && !current.valid && !$('.status').classList.contains('error')) label(current.reason);
      await flush();
      if (now() - lastUi >= 1000) { lastUi = now(); render(); }
    }
    async function reconcile() {
      if (reconciling) return reconciling;
      reconciling = reconcileOnce();
      try { await reconciling; } finally { reconciling = null; }
    }

    $('.chip').addEventListener('click', () => { panelOpen = true; render(); });
    $('.close').addEventListener('click', () => { panelOpen = false; render(); });
    $('.secondary').addEventListener('click', () => { drawerOpen = !drawerOpen; $('.drawer').hidden = !drawerOpen; $('.secondary').setAttribute('aria-expanded', String(drawerOpen)); if (drawerOpen) detailsTask = renderDetails().catch(fail); });
    $('.primary').addEventListener('click', () => {
      const current = evidence();
      if (currentId() !== selected) {
        win.location.assign(`https://m.youtube.com/watch?v=${selected}`); return;
      }
      if (!current.valid) { label(current.reason); return; }
      if (active && !ownerLost && !current.video.paused) { current.video.pause(); return; }
      meter.reset(); pendingCredits = [];
      const target = Math.min(progress.position, Math.max(0, current.duration - 0.1));
      if (Math.abs(current.video.currentTime - target) > 0.5) { restoreTarget = target; current.video.currentTime = target; }
      restored = true;
      // Keep play() in the original touch handler: await would lose mobile user activation.
      const playing = current.video.play();
      Promise.resolve(playing).then(() => {
        if (!active || ownerLost) return begin(selected);
      }).catch(() => label('유튜브 영상의 ▶ 버튼을 한 번 눌러 주세요.'));
    });
    $('#add').addEventListener('submit', (event) => {
      event.preventDefault();
      enqueue(async () => {
        const parsed = parseVideo($('#url').value);
        const current = evidence();
        const title = $('#video-title').value || (currentId() === parsed.id && current.valid ? current.title : `성경 통독 · ${parsed.id}`);
        await store.addVideo(parsed.id, title, parsed.position);
        videos = await store.videos(); selected = parsed.id; progress = await store.progress(selected);
        $('#add').reset(); label('영상이 추가되었습니다. 이어 듣기를 눌러 열어 주세요.'); render(); await renderDetails();
      }).catch(() => {});
    });
    $('#edit').addEventListener('submit', (event) => {
      event.preventDefault();
      enqueue(async () => {
        const target = parseTime($('#time').value);
        if (target === null) throw new Error('분:초 또는 시:분:초로 입력해 주세요.');
        const saved = await store.progress(selected);
        if (saved.duration && target > saved.duration) throw new Error('영상 길이보다 짧은 위치를 입력해 주세요.');
        const current = evidence();
        if (currentId() === selected && current.valid) current.video.pause();
        const token = await store.claim(selected);
        if (active?.id === selected) { active = null; ownerLost = false; meter.reset(); pendingCredits = []; restoreTarget = null; }
        await store.savePosition(selected, token, { position: target, duration: saved.duration, completed: false });
        if (currentId() === selected && current.valid) { restored = true; current.video.currentTime = target; }
        progress = await store.progress(selected); label('시작 위치를 저장했습니다.'); render(); await renderDetails();
      }).catch(() => {});
    });
    $('#export').addEventListener('click', () => enqueue(async () => {
      const backup = await store.exportBackup();
      const url = win.URL.createObjectURL(new win.Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const anchor = doc.createElement('a'); anchor.href = url; anchor.download = `drama-bible-backup-${seoulDate(now())}.json`; root.append(anchor); anchor.click(); anchor.remove();
      win.setTimeout(() => win.URL.revokeObjectURL(url), 60000); label('백업 다운로드를 요청했습니다. 다운로드 목록을 확인하세요.');
    }).catch(() => {}));
    $('#import').addEventListener('click', () => $('#file').click());
    $('#file').addEventListener('change', (event) => enqueue(async () => {
      const file = event.target.files?.[0]; if (!file) return;
      if (file.size > MAX_BACKUP_BYTES) throw new Error('5MB 이하의 백업 파일을 선택해 주세요.');
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('JSON 백업 파일을 읽을 수 없습니다.'); }
      await store.importBackup(data);
      active = null; ownerLost = false; restored = false; pendingCredits = []; meter.reset();
      videos = await store.videos(); progress = await store.progress(selected);
      event.target.value = ''; label('백업을 기존 기록에 합쳤습니다.'); render(); await renderDetails();
    }).catch(() => {}));

    const pageHide = () => { flush(true).catch(fail); };
    win.addEventListener('pagehide', pageHide);
    doc.addEventListener('visibilitychange', pageHide);
    const timer = win.setInterval(() => { reconcile().catch(fail); }, 1000);
    render(); await reconcile();
    return {
      store, root, reconcile,
      flush: () => flush(true),
      idle: async () => { if (starting) await starting; await queue; await detailsTask; },
      destroy() { destroyed = true; win.clearInterval(timer); win.removeEventListener('pagehide', pageHide); doc.removeEventListener('visibilitychange', pageHide); if (boundVideo) for (const type of events) boundVideo.removeEventListener(type, handleEvent); host.remove(); }
    };
  }

  const core = { parseTime, parseVideo, formatTime, seoulDate, splitListening, Meter, Store, validateBackup, inspectPlayer, startApp, PREFIX, MAX_BACKUP_BYTES };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }
  if (typeof GM === 'undefined' || typeof GM.getValue !== 'function') return;
  startApp({ window, document, gm: GM, page: typeof unsafeWindow === 'undefined' ? window : unsafeWindow }).catch((error) => {
    console.error('[드라마바이블 이어듣기]', error);
    const notice = document.createElement('div');
    notice.textContent = '성경 이어듣기: 저장소를 열 수 없습니다. Violentmonkey 권한을 확인하고 새로고침해 주세요.';
    notice.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;padding:16px;background:#fff1db;color:#7e321d;border:2px solid #c68b40;font:14px system-ui';
    document.documentElement.append(notice);
  });
})();
