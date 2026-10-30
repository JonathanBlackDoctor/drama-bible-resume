// ==UserScript==
// @name         드라마바이블 이어듣기
// @namespace    https://github.com/JonathanBlackDoctor/drama-bible-resume
// @version      1.2.0
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
  const CONFIRM_SECONDS = 30;
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  const validRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 4;
  const copy = (value) => JSON.parse(JSON.stringify(value));

  function parseTime(value) {
    const checked = (n) => Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null;
    if (typeof value === 'number') return checked(value);
    const text = String(value ?? '').trim();
    if (/^\d+(?:\.\d+)?s?$/.test(text)) return checked(Number(text.replace(/s$/, '')));
    if (/^\d+(?::[0-5]\d){1,2}$/.test(text)) return checked(text.split(':').reduce((n, part) => n * 60 + Number(part), 0));
    const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
    return units && text ? checked(Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0)) : null;
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

  class ResumeGuard {
    constructor() { this.pending = null; }
    reset() { this.pending = null; }
    seek(from, to, at, id, completed = false) {
      const protectedPoint = this.pending;
      this.pending = {
        id: protectedPoint?.id || id, fromPosition: protectedPoint?.fromPosition ?? from,
        fromCompleted: protectedPoint?.fromCompleted ?? completed,
        position: to, listenedSeconds: 0, startedAt: at
      };
      return { id, at, fromPosition: from, toPosition: to, kind: 'seek' };
    }
    observe(seconds, position, canConfirm = true) {
      if (!this.pending) return;
      this.pending.position = position;
      this.pending.listenedSeconds = Math.min(CONFIRM_SECONDS, this.pending.listenedSeconds + seconds);
      if (canConfirm && this.pending.listenedSeconds >= CONFIRM_SECONDS) this.pending = null;
    }
    snapshot(position, duration, completed) {
      return this.pending
        ? { position: this.pending.fromPosition, duration, completed: this.pending.fromCompleted, pending: copy(this.pending) }
        : { position, duration, completed, pending: null };
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
      let pending = null;
      if (p.pending != null) {
        const q = p.pending;
        if (!TOKEN.test(q.id) || !finite(q.fromPosition) || !finite(q.position) || !finite(q.listenedSeconds, CONFIRM_SECONDS) || !finite(q.startedAt, 9e15) || typeof q.fromCompleted !== 'boolean' || q.fromPosition !== p.position || (p.duration > 0 && q.position > p.duration + 2)) bad();
        pending = { id: q.id, fromPosition: q.fromPosition, fromCompleted: q.fromCompleted, position: q.position, listenedSeconds: q.listenedSeconds, startedAt: q.startedAt };
      }
      return { videoId: p.videoId, position: p.position, duration: p.duration, updatedAt: p.updatedAt, completed: p.completed, pending };
    });
    const seenSessions = new Set();
    const sessions = raw.sessions.map((s) => {
      if (!s || !TOKEN.test(s.id) || !ids.has(s.videoId) || !/^\d{4}-\d\d-\d\d$/.test(s.date) || !finite(s.startPosition) || !finite(s.endPosition) || !finite(s.listenedSeconds, 86400) || !finite(s.updatedAt, 9e15) || !finite(s.startedAt, 9e15)) bad();
      const day = new Date(`${s.date}T00:00:00Z`);
      if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== s.date || seenSessions.has(`${s.id}:${s.date}`)) bad();
      seenSessions.add(`${s.id}:${s.date}`);
      return { id: s.id, videoId: s.videoId, date: s.date, startPosition: s.startPosition, endPosition: s.endPosition, listenedSeconds: s.listenedSeconds, updatedAt: s.updatedAt, startedAt: s.startedAt };
    });
    if (raw.checkpoints !== undefined && (!Array.isArray(raw.checkpoints) || raw.checkpoints.length > 20000)) bad();
    const seenPoints = new Set();
    const checkpoints = (raw.checkpoints || []).map((p) => {
      if (!p || !TOKEN.test(p.id) || !ids.has(p.videoId) || !finite(p.at, 9e15) || !finite(p.fromPosition) || !finite(p.toPosition) || !['seek', 'edit', 'restore'].includes(p.kind) || seenPoints.has(p.id)) bad();
      seenPoints.add(p.id);
      return { id: p.id, videoId: p.videoId, at: p.at, fromPosition: p.fromPosition, toPosition: p.toPosition, kind: p.kind };
    });
    let settings = null;
    if (raw.settings !== undefined) {
      if (!raw.settings || !validRate(raw.settings.playbackRate)) bad();
      settings = { playbackRate: raw.settings.playbackRate };
    }
    return { videos, progress, sessions, checkpoints, settings };
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
    async checkpoint(videoId, fromPosition, toPosition, kind = 'seek') {
      const point = { id: this.uuid(), videoId, at: this.now(), fromPosition, toPosition, kind };
      await this.set(`checkpoint:${videoId}:${point.id}`, point);
      return point;
    }
    async recoverable(videoId) {
      const checkpoints = (await this.entries(`checkpoint:${videoId}:`)).filter(Boolean);
      const sessions = (await this.entries('session:')).filter((s) => s?.videoId === videoId);
      const owner = await this.get(`owner:${videoId}`);
      const archived = (await this.entries(`position:${videoId}:`)).filter((p) => p?.updatedAt > 0);
      const points = [
        ...checkpoints.map((p) => ({ at: p.at, position: p.fromPosition, label: p.kind === 'seek' ? '구간 이동 전' : p.kind === 'edit' ? '위치 수정 전' : '복원 전' })),
        ...sessions.map((s) => ({ at: s.updatedAt, position: s.endPosition, label: '재생 기록' })),
        ...archived.map((p) => ({ at: p.updatedAt, position: p.position, label: '저장된 진도' })),
        ...(owner?.seed?.updatedAt > 0 ? [{ at: owner.seed.updatedAt, position: owner.seed.position, label: '재생 시작 전' }] : [])
      ].sort((a, b) => b.at - a.at);
      const seen = new Set();
      return points.filter((p) => { const key = `${Math.floor(p.position)}:${Math.floor(p.at / 1000)}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 40);
    }
    async exportBackup() {
      const videos = await this.videos();
      const progress = await Promise.all(videos.map((video) => this.progress(video.id)));
      const sessions = (await this.entries('session:')).filter(Boolean);
      const checkpoints = (await this.entries('checkpoint:')).filter(Boolean);
      const storedRate = await this.get('playbackRate', 1);
      const settings = { playbackRate: validRate(storedRate) ? storedRate : 1 };
      return { format: 'drama-bible-resume', version: 1, exportedAt: new Date(this.now()).toISOString(), videos, progress, sessions, checkpoints, settings };
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
      for (const point of backup.checkpoints) {
        const key = `checkpoint:${point.videoId}:${point.id}`;
        if (!await this.get(key)) await this.set(key, point);
      }
      if (backup.settings) await this.set('playbackRate', backup.settings.playbackRate);
      return backup;
    }
  }

  function playbackTarget(doc, page) {
    const element = doc.getElementById('movie_player') || doc.querySelector('.html5-video-player');
    let raw;
    try { raw = page.document.getElementById('movie_player') || page.document.querySelector('.html5-video-player'); } catch { raw = element; }
    const player = raw?.wrappedJSObject || raw;
    const video = element?.querySelector('video.html5-main-video') || element?.querySelector('video');
    const button = element?.querySelector('.ytp-large-play-button, .ytp-play-button, button[aria-label^="재생"], button[aria-label^="Play"]') || doc.querySelector('.player-controls-play-pause-icon')?.closest('button');
    return { element, player, video, button };
  }

  function applyPlaybackRate(target, rate) {
    if (!validRate(rate)) return;
    if (target.element?.matches('.ad-showing, .ad-interrupting')) return;
    try { if (typeof target.player?.setPlaybackRate === 'function') target.player.setPlaybackRate(rate); } catch { /* Native media supports additional rates. */ }
    if (target.video) {
      try {
        target.video.defaultPlaybackRate = rate;
        if (Math.abs(target.video.playbackRate - rate) > 0.001) target.video.playbackRate = rate;
      } catch { /* A replaced player will be handled on its next metadata event. */ }
    }
  }

  // Run synchronously in the user's click before any storage await. Initialize YouTube itself,
  // since an uncued HTML video can have no source until the page player receives playVideo().
  function playThroughYouTube(target, rate) {
    let apiCalled = false;
    try {
      if (typeof target.player?.playVideo === 'function') {
        const result = target.player.playVideo();
        if (result && typeof result.catch === 'function') result.catch(() => {});
        apiCalled = true;
      }
      if (typeof target.player?.unMute === 'function') target.player.unMute();
    } catch { /* Fall back to the visible page control. */ }
    if (!apiCalled && target.button) target.button.click();
    applyPlaybackRate(target, rate);
    if (!target.video) return Promise.resolve();
    target.video.muted = false;
    if (target.video.volume === 0) target.video.volume = 1;
    try { return Promise.resolve(target.video.play()); } catch (error) { return Promise.reject(error); }
  }

  function pauseThroughYouTube(target) {
    try { target.player?.pauseVideo?.(); } catch { /* Fall back to the media element. */ }
    target.video?.pause();
  }

  function consumePlayTicket(win, href, at) {
    try {
      const ticket = JSON.parse(win.sessionStorage.getItem('dbr:play-ticket') || 'null');
      if (!ticket) return null;
      const url = new URL(href);
      if (at - ticket.at < 0 || at - ticket.at > 30000) { win.sessionStorage.removeItem('dbr:play-ticket'); return null; }
      if (url.searchParams.get('dbr_play') !== ticket.nonce || url.searchParams.get('v') !== ticket.id) return null;
      win.sessionStorage.removeItem('dbr:play-ticket');
      return ticket.id;
    } catch { return null; }
  }

  // A player-owned ID AND matching content duration are required. Page URL alone is unsafe.
  function inspectPlayer(doc, page, urlId) {
    try {
      const { player, element, video } = playbackTarget(doc, page);
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
    .safety{background:#fff0cf;border:1px solid #e5ca8f;border-radius:12px;padding:9px;margin-top:9px;font-size:12px}.safety button{font-size:12px;flex:1}.safety p{margin:0 0 7px}.recovery-list{max-height:190px;overflow:auto;margin-bottom:16px}.recovery-list button{width:100%;text-align:left;margin:3px 0;font-size:12px}.history-row button{font-size:12px}
    .shell{max-height:calc(100dvh - 24px);display:flex;flex-direction:column}.head,.body{flex-shrink:0}.drawer{min-height:0;flex:1 1 auto}
    .speed-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}.speed-row label{margin:0;font-size:12px}.speed-row select{font:inherit;color:#254f41;background:#fff;border:1px solid #ccd8cb;border-radius:10px;min-height:40px;min-width:100px;padding:6px 10px}.speed-row select:focus-visible{outline:3px solid #d58c37}
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
    const savedRate = await store.get('playbackRate');
    let rateConfigured = validRate(savedRate);
    const initialRate = playbackTarget(doc, page).video?.playbackRate;
    let preferredRate = rateConfigured ? savedRate : validRate(initialRate) ? initialRate : 1;
    let rateLockUntil = 0;
    let needsRateRestore = true;
    const ticketId = consumePlayTicket(win, getUrl(), now());
    let playIntent = ticketId && videos.some((v) => v.id === ticketId) ? { id: ticketId, deadline: now() + 15000, attempts: 0, lastAttempt: -Infinity } : null;
    const navigate = env.navigate || ((url) => win.location.assign(url));
    let active = null, ownerLost = false, starting = null, queue = Promise.resolve(), destroyed = false;
    let boundVideo = null, boundId = null, restored = false, drawerOpen = false, panelOpen = Boolean(initial && videos.some((v) => v.id === initial.id));
    let lastSave = 0, lastUi = 0, status = '기록은 이 기기에만 보관됩니다.', restoreTarget = null;
    let pendingCredits = [], detailsTask = Promise.resolve(), reconciling = null;
    const meter = new Meter();
    const guard = new ResumeGuard();
    const persistedMoves = new Set();
    let lastObserved = null, seekOrigin = null;
    const host = doc.createElement('aside'); host.id = 'dbr-root'; doc.documentElement.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><button class="chip" type="button">📖 성경 듣기</button><section class="shell" aria-label="드라마바이블 이어듣기"><div class="head"><span class="brand">DRAMA BIBLE · 이어듣기</span><button class="close" aria-label="패널 접기" type="button">×</button></div><div class="body"><h2 id="title"></h2><p class="muted" id="position"></p><div class="progress" role="progressbar" aria-label="영상 진도" aria-valuemin="0" aria-valuemax="100"><div class="bar"></div></div><div class="row"><button class="primary" type="button">▶ 이어 듣기</button><button class="secondary" type="button" aria-expanded="false">기록·영상</button></div><p class="status" role="status" aria-live="polite"></p></div><div class="drawer" hidden><h3>내 성경 영상</h3><div id="library"></div><form id="add"><label for="url">다른 성경 영상 추가</label><input id="url" type="url" placeholder="유튜브 영상 링크" required><label for="video-title">영상 이름 (선택)</label><input id="video-title" placeholder="예: 로마서 전체 통독" maxlength="200"><button type="submit" style="margin-top:8px;width:100%">＋ 영상 추가</button></form><details><summary>현재 위치 직접 수정</summary><form id="edit"><label for="time">시:분:초 또는 분:초</label><div class="row"><input id="time" placeholder="0:00" required><button type="submit">저장</button></div><p class="muted">선택한 영상의 다음 시작 위치를 바꿉니다.</p></form></details><div class="tools"><button id="export" type="button">백업 저장</button><button id="import" type="button">백업 가져오기</button><input id="file" type="file" accept=".json,application/json" hidden></div><p class="muted">가져오기는 기존 기록에 합칩니다. 백업에는 개인 청취 기록이 들어 있습니다.</p><h3 style="margin-top:18px">날짜별 청취 기록 <span class="count">서울 시간</span></h3><div id="history"></div><p class="muted">앞뒤로 이동한 구간은 청취 시간에 포함하지 않습니다. 백그라운드 저장은 Android 절전 설정에 따라 늦어질 수 있습니다.</p></div></section>`;
    const $ = (selector) => root.querySelector(selector);
    const speedRow = doc.createElement('div'); speedRow.className = 'speed-row';
    speedRow.innerHTML = '<label for="speed">재생 속도 · 다음에도 기억</label><select id="speed" aria-label="재생 속도"></select>';
    $('.status').before(speedRow);
    for (const rate of SPEEDS) { const option = doc.createElement('option'); option.value = String(rate); option.textContent = `${rate}배속`; $('#speed').append(option); }
    function showRate() {
      if (![...$('#speed').options].some((o) => Number(o.value) === preferredRate)) { const option = doc.createElement('option'); option.value = String(preferredRate); option.textContent = `${preferredRate}배속`; $('#speed').append(option); }
      $('#speed').value = String(preferredRate);
    }
    showRate();
    const safety = doc.createElement('div'); safety.className = 'safety'; safety.hidden = true;
    safety.innerHTML = '<p id="safety-note"></p><div class="row"><button id="undo-seek" type="button">이동 전으로 복구</button><button id="accept-seek" type="button">새 진도로 확정</button></div>';
    $('.body').append(safety);
    const recovery = doc.createElement('section');
    recovery.innerHTML = '<h3>이전 진도 복구</h3><p class="muted">기록된 위치를 누르면 복구됩니다. 시간을 기억할 필요가 없습니다.</p><div id="recovery" class="recovery-list"></div>';
    $('.drawer').prepend(recovery);
    const label = (value) => { status = value; $('.status').classList.remove('error'); $('.status').textContent = value; };
    const fail = (error) => { label(error?.message || '저장할 수 없습니다. 백업과 확장 권한을 확인해 주세요.'); $('.status').classList.add('error'); };
    const enqueue = (task) => { const result = queue.then(task); queue = result.catch(fail); return result; };
    const currentId = () => { try { return parseVideo(getUrl()).id; } catch { return null; } };
    const evidence = () => inspectPlayer(doc, page, currentId());
    const selectedPending = () => currentId() === selected && guard.pending ? guard.pending : progress.pending;

    function rememberRate(value) {
      if (!validRate(value)) return;
      preferredRate = value; rateConfigured = true; showRate();
      enqueue(() => store.set('playbackRate', preferredRate)).catch(() => {});
    }

    function finishPlayback(intent) {
      if (playIntent !== intent || currentId() !== intent.id) return;
      const current = evidence();
      if (!current.valid || !restored || current.video.paused) return;
      playIntent = null;
      if (!active || ownerLost || active.id !== intent.id) begin(intent.id).catch(fail);
      else label('듣는 중 · 자동 기록');
      render();
    }

    function requestPlayback() {
      const intent = playIntent;
      if (!intent || currentId() !== intent.id || intent.cancelled || intent.attempts >= 6) return;
      intent.attempts++; intent.lastAttempt = now(); rateLockUntil = now() + 3000;
      const target = playbackTarget(doc, page);
      // Keep the page-player call, unmute, and native play inside the trusted click's task.
      if (!restored && !target.element?.matches('.ad-showing, .ad-interrupting')) {
        try {
          const identity = target.player?.getVideoData?.()?.video_id || target.player?.getPlayerResponse?.()?.videoDetails?.videoId;
          if (identity === intent.id && typeof target.player?.seekTo === 'function') target.player.seekTo(progress.position, true);
        } catch { /* Verified-metadata restoration remains authoritative. */ }
      }
      playThroughYouTube(target, preferredRate).then(() => {
        if (intent.cancelled) { if (!playIntent) pauseThroughYouTube(playbackTarget(doc, page)); return; }
        finishPlayback(intent);
      }).catch((error) => {
        if (playIntent !== intent) return;
        intent.error = error?.name || 'PlaybackError';
        label(error?.name === 'NotAllowedError' ? '재생 허용을 기다리는 중 · 컨트롤러를 다시 누르면 취소합니다.' : '유튜브 재생 준비 중…');
        render();
      });
    }

    function cancelPlayback() {
      if (playIntent) playIntent.cancelled = true;
      playIntent = null;
      pauseThroughYouTube(playbackTarget(doc, page));
      label('일시정지했습니다.'); render();
    }

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
      const media = playbackTarget(doc, page).video;
      $('.primary').textContent = currentId() === selected && media && !media.paused ? 'Ⅱ 일시정지' : playIntent?.id === selected ? '재생 준비 중 · 취소' : '▶ 이어 듣기';
      $('.status').textContent = status;
      const pending = selectedPending();
      safety.hidden = !pending;
      if (pending) $('#safety-note').textContent = `기존 진도 ${formatTime(pending.fromPosition)} 보호 중 · 이동 후 실제 ${Math.floor(pending.listenedSeconds)}/${CONFIRM_SECONDS}초 청취. 새 위치 ${formatTime(pending.position)}`;
    }

    async function renderDetails() {
      $('#recovery').replaceChildren();
      const points = await store.recoverable(selected);
      for (const point of points) {
        const id = selected;
        const button = doc.createElement('button'); button.type = 'button';
        button.textContent = `${new Date(point.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${point.label} · ${formatTime(point.position)}로 복구`;
        button.addEventListener('click', () => setPosition(id, point.position).catch(() => {}));
        $('#recovery').append(button);
      }
      if (!points.length) { const empty = doc.createElement('p'); empty.className = 'empty'; empty.textContent = '듣던 위치와 구간 이동 전 위치가 자동으로 남습니다.'; $('#recovery').append(empty); }
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
        const restore = doc.createElement('button'); restore.type = 'button'; restore.textContent = '이 기록의 마지막 위치로 복구';
        restore.addEventListener('click', () => setPosition(session.videoId, session.endPosition).catch(() => {}));
        row.append(title, text, restore); $('#history').append(row);
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
        sample();
        progress = await store.progress(selected);
        label('듣는 중 · 자동 기록'); render();
      })();
      try { await starting; } finally { starting = null; }
    }

    function recordJump(from, to) {
      if (!restored || restoreTarget !== null || Math.abs(to - from.position) < 1) return;
      const point = guard.seek(from.position, to, now(), uuid(), Boolean(progress.completed));
      point.videoId = boundId;
      const key = `checkpoint:${boundId}:${point.id}`;
      // Append before saving a changed cursor; old recovery points are never overwritten.
      enqueue(async () => { await store.set(key, point); persistedMoves.add(point.id); }).catch(() => {});
      meter.reset(); lastSave = 0;
      label(`이동 전 ${formatTime(guard.pending.fromPosition)} 보관 · 새 위치에서 ${CONFIRM_SECONDS}초 들으면 진도로 반영합니다.`);
      if (!active || ownerLost) begin(boundId).then(() => flush(true)).catch(fail);
      render();
    }

    function setPosition(id, target, kind = 'restore') {
      const current = evidence();
      if (currentId() === id && current.valid) current.video.pause();
      return enqueue(async () => {
        const saved = await store.progress(id);
        if (!Number.isFinite(target) || target < 0 || (saved.duration && target > saved.duration)) throw new Error('영상 범위 안의 위치를 선택해 주세요.');
        await store.checkpoint(id, saved.pending?.position ?? saved.position, target, kind);
        const token = await store.claim(id);
        await store.savePosition(id, token, { position: target, duration: saved.duration, completed: false, pending: null });
        if (currentId() === id) {
          active = null; ownerLost = false; meter.reset(); pendingCredits = []; guard.reset(); seekOrigin = null;
          if (current.valid) { restored = true; restoreTarget = Math.abs(current.video.currentTime - target) > 0.5 ? target : null; if (restoreTarget !== null) current.video.currentTime = target; lastObserved = { id, position: target, at: now() }; }
        }
        selected = id; progress = await store.progress(id);
        label(kind === 'restore' ? `${formatTime(target)}로 진도를 복구했습니다. 이어 듣기를 눌러 주세요.` : '시작 위치를 저장했습니다.');
        render(); await renderDetails();
      });
    }

    function sample() {
      const current = evidence();
      if (current.valid && restored && restoreTarget === null && !current.video.seeking && !seekOrigin) {
        if (lastObserved?.id === boundId) {
          const elapsed = Math.max(0, (now() - lastObserved.at) / 1000);
          const advance = current.position - lastObserved.position;
          if (advance < -1 || advance > Math.max(5, elapsed * (current.video.playbackRate || 1) + 2)) recordJump(lastObserved, current.position);
        }
        lastObserved = { id: boundId, position: current.position, at: now() };
      }
      if (!active || ownerLost || currentId() !== active.id) { meter.reset(); return current; }
      const seconds = meter.observe({ now: now(), valid: current.valid, seeking: Boolean(current.video?.seeking || seekOrigin || restoreTarget !== null), position: current.position ?? 0, rate: current.video?.playbackRate || 1, playing: current.valid && !current.video.paused && !current.video.ended && current.video.readyState >= 2 });
      if (seconds > 0) pendingCredits.push({ at: now(), seconds, position: current.position, rate: current.video.playbackRate || 1 });
      const wasPending = Boolean(guard.pending);
      if (current.valid) guard.observe(seconds, current.position, !guard.pending || persistedMoves.has(guard.pending.id));
      if (wasPending && !guard.pending) { lastSave = 0; label('새 위치를 진도로 반영했습니다. 이동 전 위치는 기록에서 복구할 수 있습니다.'); }
      return current;
    }

    function flush(force = false) {
      const current = sample();
      if (!active || ownerLost || !current.valid || currentId() !== active.id || current.video.seeking || seekOrigin || restoreTarget !== null) return queue;
      if (!force && now() - lastSave < 3000) return queue;
      lastSave = now();
      const owner = { ...active }, credits = pendingCredits.splice(0);
      const snapshot = guard.snapshot(current.position, current.duration, Boolean(current.video.ended));
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
        label(snapshot.pending ? `기존 진도 ${formatTime(snapshot.position)} 보호 중 · 이동 전 위치는 자동 보관됩니다.` : snapshot.completed ? '완주했습니다. 기록·영상에서 다음 영상을 골라 주세요.' : `저장됨 · ${new Date(now()).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })}`);
        render();
      });
    }

    function handleEvent(event) {
      if (event.type === 'ratechange' && evidence().valid) {
        const actual = boundVideo?.playbackRate;
        if (validRate(actual) && Math.abs(actual - preferredRate) > 0.001) {
          if (rateConfigured && now() < rateLockUntil) applyPlaybackRate(playbackTarget(doc, page), preferredRate);
          else rememberRate(actual);
        }
      }
      if (event.type === 'loadedmetadata' || event.type === 'emptied') needsRateRestore = true;
      if (event.type === 'playing' && playIntent) finishPlayback(playIntent);
      if (event.type === 'seeking') {
        if (restoreTarget === null && !seekOrigin) seekOrigin = lastObserved || { id: boundId, position: progress.position, at: now() };
        meter.reset(); return;
      }
      if (event.type === 'seeking' || event.type === 'ratechange' || event.type === 'waiting') meter.reset();
      if (event.type === 'play' && restored && !active && !ownerLost) begin(boundId).catch(fail);
      if (event.type === 'playing' && restored && !active && !ownerLost) begin(boundId).catch(fail);
      if (event.type === 'seeked') {
        meter.reset();
        if (restoreTarget !== null && Math.abs(boundVideo.currentTime - restoreTarget) <= 2) { restoreTarget = null; seekOrigin = null; }
        else if (seekOrigin && evidence().valid) { const from = seekOrigin; seekOrigin = null; recordJump(from, boundVideo.currentTime); }
        lastObserved = { id: boundId, position: boundVideo.currentTime, at: now() };
      }
      if (event.type === 'pause' || event.type === 'ended' || event.type === 'seeked') flush(true).catch(fail);
      else flush().catch(fail);
    }
    const events = ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'waiting', 'timeupdate', 'loadedmetadata', 'canplay', 'emptied'];

    async function reconcileOnce() {
      if (destroyed) return;
      const id = currentId(), current = evidence();
      const registered = videos.some((v) => v.id === id);
      const video = registered ? current.video : null;
      if (playIntent && playIntent.id !== id) { playIntent.cancelled = true; playIntent = null; }
      if (boundVideo !== video || boundId !== id) {
        if (boundVideo) for (const type of events) boundVideo.removeEventListener(type, handleEvent);
        // Old-player samples must never be saved under a new URL ID.
        active = null; ownerLost = false; restored = false; restoreTarget = null; meter.reset(); pendingCredits = [];
        guard.reset(); lastObserved = null; seekOrigin = null;
        needsRateRestore = true; rateLockUntil = now() + 3000;
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
        lastObserved = { id, position: target, at: now() };
        if (playIntent) { playIntent.deadline = now() + 15000; requestPlayback(); }
        if (!current.video.paused) await begin(id);
        label(saved.completed ? '완주한 영상입니다. 위치를 바꾸거나 다음 영상을 선택하세요.' : '이어 듣기를 누르면 마지막 위치부터 재생합니다.');
      }
      if (active && !ownerLost && !await store.owns(active.id, active.token)) {
        ownerLost = true; meter.reset(); pendingCredits = []; guard.reset(); label('다른 탭에서 재생 중 · 이 탭의 기록은 멈췄습니다.');
      }
      if (ownerLost && selected === active?.id) progress = await store.progress(selected);
      if (!current.valid) needsRateRestore = true;
      if (registered && current.valid && needsRateRestore) {
        if (rateConfigured) { rateLockUntil = now() + 3000; applyPlaybackRate(playbackTarget(doc, page), preferredRate); }
        else if (validRate(current.video.playbackRate)) { preferredRate = current.video.playbackRate; showRate(); }
        needsRateRestore = false;
      }
      if (playIntent) {
        const target = playbackTarget(doc, page);
        if (current.valid && restored && target.video && !target.video.paused) finishPlayback(playIntent);
        else if (!target.video || target.video.paused) {
          if (now() >= playIntent.deadline) {
            const blocked = playIntent.error === 'NotAllowedError'; playIntent.cancelled = true; playIntent = null;
            fail(new Error(blocked ? '브라우저가 재생을 차단했습니다. 이 컨트롤러의 재생 버튼을 다시 눌러 주세요.' : '유튜브 재생 준비가 지연됐습니다. 이 컨트롤러에서 다시 재생해 주세요.'));
          } else if (now() - playIntent.lastAttempt >= 2000) requestPlayback();
        }
      }
      if (registered && !current.valid && !playIntent && !$('.status').classList.contains('error')) label(current.reason);
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
    $('#speed').addEventListener('change', () => {
      const rate = Number($('#speed').value);
      if (!validRate(rate)) return;
      meter.reset(); rememberRate(rate); rateLockUntil = now() + 3000;
      applyPlaybackRate(playbackTarget(doc, page), rate);
      label(`${rate}배속 저장 · 다음 재생에도 적용합니다.`);
    });
    $('.primary').addEventListener('click', () => {
      const current = evidence();
      if (currentId() !== selected) {
        const url = new URL('/watch', new URL(getUrl()).origin); url.searchParams.set('v', selected);
        const nonce = uuid();
        try { win.sessionStorage.setItem('dbr:play-ticket', JSON.stringify({ id: selected, nonce, at: now() })); url.searchParams.set('dbr_play', nonce); } catch { url.searchParams.set('autoplay', '1'); }
        navigate(url.href); return;
      }
      const media = playbackTarget(doc, page).video;
      if (playIntent || (media && !media.paused)) { cancelPlayback(); return; }
      meter.reset(); pendingCredits = [];
      guard.reset(); seekOrigin = null;
      if (current.valid) {
        const target = Math.min(progress.position, Math.max(0, current.duration - 0.1));
        if (Math.abs(current.video.currentTime - target) > 0.5) { restoreTarget = target; current.video.currentTime = target; }
        restored = true;
      }
      if (!rateConfigured) rememberRate(preferredRate);
      playIntent = { id: selected, deadline: now() + 15000, attempts: 0, lastAttempt: -Infinity };
      label('유튜브 재생 준비 중…'); render();
      requestPlayback();
    });
    $('#undo-seek').addEventListener('click', () => { const pending = selectedPending(); if (pending) setPosition(selected, pending.fromPosition).catch(() => {}); });
    $('#accept-seek').addEventListener('click', () => { const pending = selectedPending(); if (pending) setPosition(selected, pending.position, 'edit').catch(() => {}); });
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
      const target = parseTime($('#time').value);
      if (target === null) { fail(new Error('분:초 또는 시:분:초로 입력해 주세요.')); return; }
      setPosition(selected, target, 'edit').catch(() => {});
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
      guard.reset(); seekOrigin = null; lastObserved = null;
      videos = await store.videos(); progress = await store.progress(selected);
      const restoredRate = await store.get('playbackRate');
      if (validRate(restoredRate)) { preferredRate = restoredRate; rateConfigured = true; showRate(); needsRateRestore = true; }
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

  const core = { parseTime, parseVideo, formatTime, seoulDate, splitListening, Meter, ResumeGuard, Store, validateBackup, playbackTarget, applyPlaybackRate, playThroughYouTube, pauseThroughYouTube, consumePlayTicket, validRate, inspectPlayer, startApp, PREFIX, MAX_BACKUP_BYTES, CONFIRM_SECONDS };
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
