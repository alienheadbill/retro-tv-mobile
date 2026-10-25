'use strict';
// The phone TV. Same behaviour as the desktop TV (src/app.js): channels already on when you tune
// in, static between channels, banner, guide, profiles. Different plumbing: videos come from
// on-device storage (or stream from the archive), live channels are embedded players, and
// it's driven by touch.

const $ = (s) => document.querySelector(s);
const screenEl = $('#screen');
const localVideo = $('#local');

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('rtv.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('rtv.' + k, JSON.stringify(v));
    } catch {}
  },
};

const state = {
  settings: {},
  all: [],
  channels: [],
  profile: null,
  scheduledProfile: null,
  index: 0,
  last: null,
  muted: false,
  cycles: new Map(),
  status: new Map(), // Twitch on-air status by channel number
  on: false, // powered on (first tap done)
};

let token = 0;
let live = null; // { frame, ch }
let localNow = null; // { ch, loc, file, sub, slotStart, slotEnd }
let objectUrl = null;

// ---------- Playback health (src/health.js, the same as the PC's) ----------
// A failed source rests before it's tried again, and the schedule never changes because of it:
// its time slot gets a stand-in instead (the same one the PC would pick).

const health = Health.monitor({ records: store.get('health', {}) });
const keyOf = (f) => f.key || f.url;
const kindOf = (f) => (f.youtube ? 'youtube' : f.stream ? 'remote' : 'file');
setInterval(() => health.takeChanged() && store.set('health', health.all(300)), 5000);

// ---------- Schedules ----------

const viewed = new Map();
const lookup = (n) => viewed.get(n) || null;
const durationOf = (f) => f.dur || 0;

function cycleFor(ch) {
  if (!state.cycles.has(ch.number)) {
    const breaks = { bumpers: 1, commercials: 3, ...(state.settings.breaks || {}), ...(ch.breaks || {}) };
    state.cycles.set(ch.number, Schedule.build(withOrder(ch), durationOf, breaks, lookup));
  }
  return state.cycles.get(ch.number);
}

// Sports and wrestling channels ("order": "grouped") play in history order or at random; ORDER
// on the remote switches the channel you're on. Series and events stay in order either way.
function withOrder(ch) {
  const pref = ch.order === 'grouped' ? store.get('order.' + ch.number, null) : null;
  if (!pref) return ch;
  return { ...ch, groupOrder: pref === 'history' ? ch.historyOrder || 'date' : 'shuffle' };
}

function toggleOrder() {
  const ch = state.channels[state.index];
  if (!ch || ch.order !== 'grouped') return flashOsd('ORDER', 'THIS CHANNEL ALWAYS PLAYS AT RANDOM', 2500);
  const next = withOrder(ch).groupOrder === 'shuffle' ? 'history' : 'random';
  store.set('order.' + ch.number, next);
  state.cycles.delete(ch.number);
  tune(state.index, { quiet: true });
  flashOsd(next === 'history' ? 'IN HISTORY ORDER' : 'AT RANDOM', ch.name.toUpperCase(), 3000);
}

const showLabel = (p) => (p.show && p.show !== p.title && !p.title.startsWith(p.show) ? `${p.show}: ${p.title}` : p.title);

function listings(ch, from, to) {
  if (ch.type === 'local') {
    const sub = localNow && localNow.ch.number === ch.number && localNow.sub ? localNow : null;
    return Schedule.listings(cycleFor(ch), from, to).map((p) =>
      sub && Math.abs(p.start - sub.slotStart) < 2000 ? { ...p, title: `${showLabel(sub.file)} (stand-in)`, substituted: true } : { ...p, title: showLabel(p) }
    );
  }
  if (!navigator.onLine) return [{ live: true, off: true, title: 'No signal: no internet', start: from, end: to }];
  const st = state.status.get(ch.number);
  const off = !!st && !st.online;
  return [{ live: true, off, title: (!off && st && st.title) || ch.description || ch.name, start: from, end: to }];
}

// ---------- Tuning ----------

function teardown() {
  clearTimeout(blockTimer);
  clearTimeout(slotTimer);
  clearTimeout(loadTimer);
  if (live) {
    live.frame.remove();
    live = null;
  }
  stopYouTube();
  localVideo.onloadedmetadata = localVideo.onended = localVideo.onerror = localVideo.onplaying = null;
  localVideo.pause();
  localVideo.removeAttribute('src');
  localVideo.load();
  localVideo.classList.remove('on');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  localNow = null;
  standby(null);
  document.body.classList.remove('live-on');
}

function standby(big, small = '') {
  const el = $('#standby');
  el.hidden = !big;
  if (big) {
    el.querySelector('.big').textContent = big;
    el.querySelector('.small').textContent = small;
  }
}

function tune(i, { quiet = false } = {}) {
  const n = state.channels.length;
  if (!n) return;
  i = ((i % n) + n) % n;
  if (i !== state.index) state.last = state.index;
  state.index = i;
  const ch = state.channels[i];
  store.set('channel', ch.number);
  const t = ++token;
  Effects.snow(quiet ? 300 : 600, state.muted ? 0 : 0.8);
  teardown();
  showOsd(ch);
  if (ch.type === 'local') playLocal(ch, t);
  else playLive(ch, t);
  setTimeout(() => t === token && showBanner(), 700);
}

function tuneNumber(num) {
  const i = state.channels.findIndex((c) => c.number === num);
  if (i >= 0) tune(i);
  else flashOsd(String(num).padStart(2, '0'), 'NO SIGNAL');
}

// ---------- Live channels: the sites' own embeddable players ----------

function liveUrl(ch) {
  if (ch.type === 'twitch') {
    return `https://player.twitch.tv/?channel=${encodeURIComponent(ch.channel)}&parent=${encodeURIComponent(location.hostname)}&autoplay=true&muted=false`;
  }
  if (ch.type === 'youtube-live') {
    // The stream found when the app was published; if it has restarted since, fall back to
    // whatever the channel is streaming now.
    return ch.videoId
      ? `https://www.youtube.com/embed/${ch.videoId}?autoplay=1&playsinline=1&rel=0`
      : `https://www.youtube.com/embed/live_stream?channel=${ch.channelId}&autoplay=1&playsinline=1`;
  }
  return new URL('/embed/video', ch.url).href; // owncast
}

function playLive(ch, t) {
  if (!navigator.onLine) return standby('NO SIGNAL', 'No internet. The channels on your phone still work.');
  const st = state.status.get(ch.number);
  if (st && !st.online) return standby('OFF THE AIR', st.gone ? `${ch.name} has signed off for good` : `${ch.name} isn't broadcasting right now`);
  // YouTube streams go through the same controllable player as scheduled YouTube channels
  // (captions off, swipes work once it's playing). If that stream has ended, fall back to whatever
  // the channel is streaming now.
  if (ch.type === 'youtube-live' && ch.videoId && !ch.fallback) {
    return playYouTube({ youtube: ch.videoId }, null, () => t === token && tune(state.index, { quiet: true }), () => {
      if (t !== token) return;
      stopYouTube();
      playLive({ ...ch, fallback: true, videoId: null }, t);
    }, t);
  }
  const frame = document.createElement('iframe');
  frame.src = liveUrl(ch);
  frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  frame.setAttribute('allowfullscreen', '');
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  screenEl.insertBefore(frame, $('#standby'));
  live = { frame, ch };
  // Taps go to the site's player (to press its play button), so the remote stays reachable.
  document.body.classList.add('live-on');
  if (ch.type === 'twitch') refreshStatus(ch).then((s) => t === token && s && !s.online && tune(state.index, { quiet: true }));
}

const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
async function refreshStatus(ch) {
  if (ch.type !== 'twitch' || !navigator.onLine) return null;
  try {
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_WEB_CLIENT_ID, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ query: 'query($login: String!) { user(login: $login) { stream { title } } }', variables: { login: ch.channel } }),
    });
    const user = (await res.json()).data.user;
    const s = !user ? { online: false, gone: true, title: '' } : { online: !!user.stream, title: user.stream ? user.stream.title : '' };
    state.status.set(ch.number, s);
    return s;
  } catch {
    return null;
  }
}

// ---------- Your own videos ----------

async function playLocal(ch, t) {
  if (!ch.episodes.length) return standby('NO SHOWS YET', 'Add videos in the menu');
  playLocalAt(ch, Date.now(), t);
}

async function resolveUrl(file) {
  if (file.stream) return file.stream;
  const blob = await DB.blob(file.id);
  if (!blob) throw new Error('missing');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  return objectUrl;
}

let blockTimer = 0;
let slotTimer = 0;
let loadTimer = 0;

// Plays what the schedule says is on at `at`. opts (from recovery): { file, offset } plays that
// instead in this time slot; retries / tried count what's been attempted for it.
async function playLocalAt(ch, at, t, opts = {}) {
  clearTimeout(blockTimer);
  clearTimeout(slotTimer);
  clearTimeout(loadTimer);
  const loc = Schedule.locate(cycleFor(ch), at);
  if (!loc) return standby('NO SIGNAL', "None of this channel's videos would play");
  const scheduled = loc.item.file;
  const slotStart = Math.round(at - loc.offset * 1000);
  const slotEnd = slotStart + Math.round(loc.item.dur * 1000);
  const cur = { ch, t, loc, scheduled, slotStart, slotEnd, retries: opts.retries || 0, tried: opts.tried || [] };
  cur.file = opts.file || scheduled;
  cur.offset = opts.file ? opts.offset || 0 : loc.offset;
  if (!opts.file && !opts.force && !health.usable(keyOf(scheduled))) {
    const sub = standIn(cur, []);
    if (!sub) return standbyUntil(cur);
    cur.file = sub.file;
    cur.offset = sub.offset;
  }
  localNow = { ch, loc, file: cur.file, sub: cur.file !== scheduled ? { original: scheduled } : null, slotStart, slotEnd };
  const untilSwitch = loc.contextEnd - Date.now();
  if (untilSwitch < (loc.item.dur - loc.offset) * 1000 && untilSwitch < 2 ** 31 - 1) {
    blockTimer = setTimeout(() => t === token && playLocalAt(ch, Date.now() + 250, t), Math.max(0, untilSwitch) + 100);
  }
  if (cur.file !== scheduled) slotTimer = setTimeout(() => t === token && playLocalAt(ch, Date.now() + 250, t), Math.max(0, slotEnd - Date.now()) + 100);
  standby(null);
  const file = cur.file;
  const started = Date.now();
  const ok = () => t === token && health.ok(keyOf(file), { loadMs: Date.now() - started, kind: kindOf(file) });
  // Not started after a while: a hiccup, like an error. (Waiting for the viewer's first tap,
  // which iOS needs before anything can play with sound, doesn't count.)
  const waitingForTap = () => document.body.classList.contains('yt-tap') || !$('#tap-play').hidden;
  const watchStart = () => {
    loadTimer = setTimeout(() => (t !== token ? null : waitingForTap() ? watchStart() : recover(cur, 'took too long to start')), file.youtube ? 30000 : 25000);
  };
  watchStart();
  if (file.youtube) {
    localVideo.pause();
    localVideo.classList.remove('on');
    return playYouTube(file, cur.offset, () => finished(cur), (code) => recover(cur, `YouTube error ${code || ''}`.trim(), [100, 101, 150].includes(code)), t, () => {
      clearTimeout(loadTimer);
      ok();
    });
  }
  stopYouTube();
  let url;
  try {
    url = await resolveUrl(file);
  } catch {
    return recover(cur, 'not on this device', true);
  }
  if (t !== token) return;
  localVideo.onloadedmetadata = () => {
    if (t !== token) return;
    localVideo.currentTime = Math.min(cur.offset, Math.max(0, (localVideo.duration || Infinity) - 1));
    play();
  };
  localVideo.onplaying = () => {
    clearTimeout(loadTimer);
    ok();
  };
  localVideo.onended = () => finished(cur);
  localVideo.onerror = () => recover(cur, (localVideo.error && ['', 'stopped', 'network error', "couldn't decode", 'missing or unsupported'][localVideo.error.code]) || 'error', !!localVideo.error && localVideo.error.code === 3);
  localVideo.muted = state.muted;
  localVideo.src = url;
  localVideo.classList.add('on');
  if (loc.item.kind === 'show' && cur.offset < 2) setTimeout(() => t === token && showBanner(), 1000);
}

// A stand-in for the slot (see src/health.js): same show first, same kind of program.
function standIn(cur, exclude) {
  const kind = cur.loc.item.kind;
  const pool = kind === 'bumper' ? cur.ch.bumpers : kind === 'commercial' ? cur.ch.commercials : cur.ch.episodes;
  const file = Health.substitute(cur.scheduled, pool, { usable: health.usable, seed: `${cur.ch.number}|${cur.slotStart}`, exclude: [...cur.tried, ...exclude] });
  if (!file) return null;
  const elapsed = (Date.now() - cur.slotStart) / 1000;
  return { file, offset: (file.dur || 0) > elapsed + 30 ? Math.max(0, elapsed) : 0 };
}

function standbyUntil(cur) {
  localNow = { ch: cur.ch, loc: cur.loc, file: cur.scheduled, sub: null, slotStart: cur.slotStart, slotEnd: cur.slotEnd };
  stopYouTube();
  localVideo.pause();
  localVideo.classList.remove('on');
  standby('PLEASE STAND BY', "We'll be right back");
  slotTimer = setTimeout(() => cur.t === token && playLocalAt(cur.ch, Date.now() + 250, cur.t), Math.max(0, cur.slotEnd - Date.now()) + 100);
}

// Something in a slot failed: try it again once, then a stand-in for the rest of the slot.
function recover(cur, reason, permanent = false) {
  if (cur.t !== token || cur.done) return;
  cur.done = true;
  clearTimeout(loadTimer);
  health.fail(keyOf(cur.file), { reason, permanent, kind: kindOf(cur.file) });
  const step = cur.file === cur.scheduled ? Health.nextStep({ retries: cur.retries, permanent }) : 'substitute';
  if (step === 'retry') return playLocalAt(cur.ch, Date.now(), cur.t, { retries: cur.retries + 1, force: true });
  const sub = standIn(cur, [keyOf(cur.file)]);
  if (!sub) return standbyUntil(cur);
  playLocalAt(cur.ch, Date.now(), cur.t, { file: sub.file, offset: sub.offset, tried: [...cur.tried, keyOf(cur.file)], retries: 99 });
}

function finished(cur) {
  if (cur.t !== token || cur.done) return;
  cur.done = true;
  if (cur.file !== cur.scheduled && Date.now() < cur.slotEnd - 3000) {
    const sub = standIn(cur, [keyOf(cur.file)]);
    if (!sub) return standbyUntil(cur);
    return playLocalAt(cur.ch, Date.now(), cur.t, { file: sub.file, offset: 0, tried: [...cur.tried, keyOf(cur.file)], retries: 99 });
  }
  playLocalAt(cur.ch, Date.now() + 750, cur.t);
}

// ---------- YouTube videos on scheduled channels ----------

// One YouTube player, reused for every video: iOS remembers that it was allowed to play with
// sound, so only the very first video needs a tap.
let ytPlayer = null;
let ytLoading = null;
let ytHandlers = {};

function loadYouTubeApi() {
  if (!ytLoading) {
    ytLoading = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.append(s);
    });
  }
  return ytLoading;
}

// Sizes the YouTube player so the video's picture box (file.crop, measured on the PC: bars and
// backgrounds cut away) fills the screen. Without a crop the whole 16:9 frame is fitted.
let ytCrop = null;
function layoutYouTube() {
  const host = $('#yt-host');
  const f = host && host.querySelector('iframe');
  if (!f || host.hidden) return;
  const cw = host.clientWidth;
  const ch = host.clientHeight;
  const c = ytCrop || { x: 0, y: 0, w: 1, h: 1 };
  const aspect = (c.w * 16) / (c.h * 9);
  const dw = aspect > cw / ch ? cw : ch * aspect;
  const dh = dw / aspect;
  const fw = dw / c.w;
  const fh = (fw * 9) / 16;
  Object.assign(f.style, { inset: 'auto', width: `${fw}px`, height: `${fh}px`, left: `${(cw - dw) / 2 - c.x * fw}px`, top: `${(ch - dh) / 2 - c.y * fh}px` });
}
window.addEventListener('resize', layoutYouTube);
// Turning the phone: iOS settles on the new size in steps, after the resize event. Lay out again
// whenever the box really changes size, and once more when the rotation has finished.
if (window.ResizeObserver) new ResizeObserver(() => layoutYouTube()).observe($('#yt-host'));
window.addEventListener('orientationchange', () => [150, 500, 1000].forEach((ms) => setTimeout(layoutYouTube, ms)));

// YouTube's own ads. The embedded player doesn't say when one is on, but the show's clock stops
// (or its length changes to the ad's) while the player says it's playing. During one the whole
// frame is shown, not the show's crop (which would cut off the ad's Skip button), and taps go to
// the player so Skip can be tapped.
let ytAdWatch = 0;
function watchForAds(file, t) {
  clearInterval(ytAdWatch);
  document.body.classList.remove('yt-ad');
  const crop = file.crop || null;
  let last = -1;
  let still = 0;
  let ad = false;
  const set = (on) => {
    if (on === ad) return;
    ad = on;
    ytCrop = on ? null : crop;
    layoutYouTube();
    document.body.classList.toggle('yt-ad', on);
    if (on) flashOsd('COMMERCIAL', 'TAP SKIP ON THE PICTURE WHEN IT SHOWS UP', 4000);
  };
  ytAdWatch = setInterval(() => {
    if (t !== token || !ytPlayer || !ytPlayer.getPlayerState) return;
    if (ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) return;
    const now = ytPlayer.getCurrentTime();
    const len = ytPlayer.getDuration();
    still = Math.abs(now - last) < 0.25 ? still + 1 : 0;
    last = now;
    const wrongLength = file.dur && len > 0 && len < 300 && Math.abs(len - file.dur) > 30;
    set(still >= 3 || wrongLength);
  }, 1000);
}

async function playYouTube(file, offset, onEnd, onError, t, onPlay) {
  const host = $('#yt-host');
  host.hidden = false;
  ytCrop = file.crop || null;
  layoutYouTube();
  watchForAds(file, t);
  ytHandlers = {
    state: (e) => {
      if (t !== token) return;
      if (e.data === YT.PlayerState.ENDED) onEnd();
      if (e.data === YT.PlayerState.PLAYING) {
        captionsOff();
        if (onPlay) onPlay();
      }
      // Until it plays, taps go to YouTube's own play button.
      document.body.classList.toggle('yt-tap', e.data !== YT.PlayerState.PLAYING && e.data !== YT.PlayerState.BUFFERING);
    },
    error: (e) => t === token && onError(e && e.data),
  };
  // offset null = a live stream: join it live rather than seeking.
  const start = offset == null ? undefined : Math.floor(offset);
  try {
    await loadYouTubeApi();
  } catch {
    return onError();
  }
  if (t !== token) return;
  if (!ytPlayer) {
    ytPlayer = new YT.Player('yt-player', {
      videoId: file.youtube,
      playerVars: {
        autoplay: 1, controls: 0, playsinline: 1, rel: 0, fs: 0, disablekb: 1, iv_load_policy: 3, modestbranding: 1,
        // No captions unless the phone itself insists (iOS "Closed Captions + SDH" setting).
        cc_load_policy: 0, cc_lang_pref: 'en', hl: 'en',
        ...(start != null ? { start } : {}),
      },
      events: {
        onReady: () => {
          layoutYouTube();
          if (state.muted) ytPlayer.mute();
        },
        onStateChange: (e) => ytHandlers.state && ytHandlers.state(e),
        onError: (e) => ytHandlers.error && ytHandlers.error(e),
      },
    });
    document.body.classList.add('yt-tap');
  } else {
    ytPlayer.loadVideoById(start != null ? { videoId: file.youtube, startSeconds: start } : { videoId: file.youtube });
    state.muted ? ytPlayer.mute() : ytPlayer.unMute();
  }
}

// YouTube turns captions on for some videos (and remembers it); switch them off each time.
function captionsOff() {
  try {
    ytPlayer.unloadModule('captions');
    ytPlayer.unloadModule('cc');
    ytPlayer.setOption('captions', 'track', {});
  } catch {}
}

function stopYouTube() {
  ytHandlers = {};
  clearInterval(ytAdWatch);
  document.body.classList.remove('yt-tap', 'yt-ad');
  if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
  const host = $('#yt-host');
  if (host) host.hidden = true;
}

// iOS only lets a video play with sound after a tap. If it refuses, ask for one.
function play() {
  localVideo.play().then(
    () => ($('#tap-play').hidden = true),
    () => ($('#tap-play').hidden = false)
  );
}
$('#tap-play').addEventListener('click', () => {
  $('#tap-play').hidden = true;
  localVideo.play().catch(() => {});
});

function toggleMute() {
  state.muted = !state.muted;
  localVideo.muted = state.muted;
  if (ytPlayer && ytPlayer.mute) state.muted ? ytPlayer.mute() : ytPlayer.unMute();
  flashOsd(state.muted ? 'MUTE' : 'SOUND ON', '', 1500);
}

// ---------- On-screen display ----------

let osdTimer = 0;
function flashOsd(big, small, ms = 3000) {
  const el = $('#osd');
  el.querySelector('.ch').textContent = big;
  el.querySelector('.name').textContent = small;
  el.classList.add('on');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.classList.remove('on'), ms);
}

const showOsd = (ch) => flashOsd(`CH ${String(ch.number).padStart(2, '0')}`, ch.name.toUpperCase());

let bannerTimer = 0;
function showBanner() {
  const ch = state.channels[state.index];
  if (!ch) return;
  const el = $('#banner');
  const now = Date.now();
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let netText = ch.name;
  let nowText;
  let nextText = '';
  let progress = null;
  if (ch.type === 'local' && localNow && localNow.ch.number === ch.number) {
    const lst = Schedule.listings(cycleFor(ch), now, now + 6 * 3600e3);
    const cur = lst[0];
    const nxt = lst[1];
    const file = localNow.file || localNow.loc.item.file;
    if (cur.block) netText += ` · ${cur.block}`;
    nowText = localNow.loc.item.kind === 'show' ? showLabel(cur) : `${showLabel(cur)} (commercial break)`;
    if (localNow.sub && localNow.loc.item.kind === 'show') nowText = `${showLabel(file)} (standing in for ${showLabel(localNow.sub.original)})`;
    if (cur.broadcast) {
      const aired = file.airDate ? new Date(file.airDate + 'T12:00').toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : file.year;
      nextText = ['Original broadcast', file.network, aired && `aired ${aired}`].filter(Boolean).join(' · ');
    } else if (nxt) nextText = `Up next at ${time(nxt.start)}: ${showLabel(nxt)}`;
    progress = Math.min(1, (now - cur.start) / (cur.end - cur.start));
  } else {
    const l = listings(ch, now, now + 1)[0];
    nowText = l ? l.title : ch.name;
    nextText = ch.type === 'local' || (l && l.off) ? '' : 'LIVE';
  }
  el.replaceChildren();
  const div = (cls, text) => Object.assign(document.createElement('div'), { className: cls, textContent: text });
  const mid = div('mid', '');
  mid.append(div('net', netText), div('now', nowText), div(nextText === 'LIVE' ? 'next live' : 'next', nextText));
  if (progress != null) {
    const bar = div('bar', '');
    const fill = document.createElement('i');
    fill.style.width = progress * 100 + '%';
    bar.append(fill);
    mid.append(bar);
  }
  el.append(div('num', String(ch.number).padStart(2, '0')), mid, div('clock', time(now)));
  el.classList.add('on');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('on'), 5000);
}

// ---------- Profiles and PIN ----------

const menu = $('#menu');
const profiles = () => state.settings.profiles || {};
const currentProfile = () => profiles()[state.profile] || null;

function applyProfile() {
  const p = currentProfile();
  const curNum = state.channels[state.index] && state.channels[state.index].number;
  viewed.clear();
  for (const ch of state.all) {
    if (ch.type === 'local') viewed.set(ch.number, { ...ch, episodes: ch.episodes.filter((f) => Profiles.allowsFile(p, f, ch)) });
  }
  state.channels = state.all
    .map((ch) => (ch.type === 'local' ? viewed.get(ch.number) : ch))
    .filter((ch) => Profiles.allowsChannel(p, ch) && (ch.type !== 'local' || ch.episodes.length));
  state.cycles.clear();
  const i = state.channels.findIndex((c) => c.number === curNum);
  state.index = i >= 0 ? i : 0;
  state.last = null;
  return i >= 0;
}

function setProfile(id) {
  if (!profiles()[id]) return;
  state.profile = id;
  store.set('profile', id);
  const kept = applyProfile();
  flashOsd(profiles()[id].label || id.toUpperCase(), 'PROFILE', 3000);
  if (!state.channels.length) {
    teardown();
    return standby('NO CHANNELS', 'This profile has no channels with anything to watch');
  }
  if (!kept || !(localNow || live)) tune(state.index, { quiet: true });
}

const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });

function closeMenu() {
  menu.hidden = true;
  menu.replaceChildren();
}

// On-screen PIN pad. Resolves true for the right PIN; no PIN set means no lock.
function askPin(reason) {
  const pin = String(state.settings.pin || '');
  if (!pin) return Promise.resolve(true);
  return new Promise((resolve) => {
    let typed = '';
    const shown = el('div', 'pin', 'PIN  ' + '_'.repeat(pin.length));
    const pad = el('div', 'pad');
    const finish = (ok) => {
      closeMenu();
      resolve(ok);
    };
    const press = (k) => {
      if (k === '⌫') typed = typed.slice(0, -1);
      else typed += k;
      shown.textContent = 'PIN  ' + '*'.repeat(typed.length) + '_'.repeat(Math.max(0, pin.length - typed.length));
      if (typed.length >= pin.length) {
        if (typed === pin) return finish(true);
        typed = '';
        shown.textContent = 'WRONG PIN';
      }
    };
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0']) {
      const b = el('button', '', k);
      b.addEventListener('click', () => press(k));
      pad.append(b);
    }
    const cancel = el('button', 'hint', 'Cancel');
    cancel.addEventListener('click', () => finish(false));
    menu.replaceChildren(el('h2', '', reason), shown, pad, cancel);
    menu.hidden = false;
  });
}

function openProfileMenu() {
  const ids = Object.keys(profiles());
  if (!ids.length) return flashOsd('NO PROFILES', '', 2000);
  menu.replaceChildren(el('h2', '', "WHO'S WATCHING?"));
  for (const id of ids) {
    const p = profiles()[id];
    const b = el('button', 'choice', `${(p.label || id).toUpperCase()}${p.locked ? '  (PIN)' : ''}${id === state.profile ? '  <' : ''}`);
    b.addEventListener('click', async () => {
      closeMenu();
      if (id === state.profile) return;
      if (p.locked && !(await askPin(`UNLOCK ${(p.label || id).toUpperCase()}`))) return;
      setProfile(id);
    });
    menu.append(b);
  }
  const cancel = el('button', 'hint', 'Cancel');
  cancel.addEventListener('click', closeMenu);
  menu.append(cancel);
  menu.hidden = false;
}

// ---------- Remote: buttons, number pad, swipes ----------

let digits = '';
let digitTimer = 0;
function typeDigit(d) {
  digits += d;
  flashOsd(`CH ${digits.padEnd(2, '-')}`, '', 2000);
  clearTimeout(digitTimer);
  const maxNum = Math.max(...state.channels.map((c) => c.number));
  const go = () => {
    const n = Number(digits);
    digits = '';
    tuneNumber(n);
  };
  if (Number(digits + '0') > maxNum || digits.length >= 3) go();
  else digitTimer = setTimeout(go, 1500);
}

const guideApi = () => ({ channels: state.channels, current: () => state.index, listings, tune: (i) => tune(i), scroll: true });

// The phone guide gets a button to close it without changing the channel.
(() => {
  const close = Object.assign(document.createElement('button'), { className: 'guide-close', textContent: 'CLOSE GUIDE' });
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    Guide.close();
  });
  $('#guide .guide-info').append(close);
})();

const actions = {
  up: () => tune(state.index + 1),
  down: () => tune(state.index - 1),
  last: () => state.last != null && tune(state.last),
  guide: () => (Guide.isOpen() ? Guide.close() : Guide.open(guideApi())),
  info: () => showBanner(),
  mute: () => toggleMute(),
  profile: () => openProfileMenu(),
  crt: () => {
    const on = !document.body.classList.contains('crt');
    document.body.classList.toggle('crt', on);
    store.set('crt', on);
  },
  menu: async () => {
    if (await askPin('MENU')) Manage.open();
  },
  order: toggleOrder,
};

document.querySelectorAll('[data-act]').forEach((b) =>
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.on) return;
    remoteShown();
    actions[b.dataset.act]();
  })
);
document.querySelectorAll('[data-digit]').forEach((b) =>
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    remoteShown();
    typeDigit(b.dataset.digit);
  })
);

// In landscape the remote floats over the picture and hides itself.
let remoteTimer = 0;
function remoteShown() {
  document.body.classList.add('remote-up');
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => document.body.classList.remove('remote-up'), 5000);
}

// Swipe up/down on the picture to change channels; tap for the banner and remote.
const gesture = $('#crt');
let touch = null;
gesture.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  touch = { x: t.clientX, y: t.clientY, at: Date.now() };
}, { passive: true });
gesture.addEventListener('touchend', (e) => {
  if (!touch || !state.on) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  touch = null;
  if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.5) {
    if (Guide.isOpen()) Guide.scrollBy(dy < 0 ? 1 : -1);
    else tune(state.index + (dy < 0 ? 1 : -1));
  } else if (Math.abs(dx) < 15 && Math.abs(dy) < 15 && !Guide.isOpen()) {
    showBanner();
    remoteShown();
  }
});
// Keyboards (an iPad with a keyboard) get the desktop keys.
document.addEventListener('keydown', (e) => {
  if (!state.on || !menu.hidden || Manage.isOpen()) return;
  if (Guide.isOpen() && Guide.key(e)) return;
  const k = e.key;
  if (k === 'ArrowUp' || k === 'PageUp') actions.up();
  else if (k === 'ArrowDown' || k === 'PageDown') actions.down();
  else if (/^[0-9]$/.test(k)) typeDigit(k);
  else if (k === 'Backspace') actions.last();
  else if (k.toLowerCase() === 'g') actions.guide();
  else if (k.toLowerCase() === 'i' || k === 'Enter') actions.info();
  else if (k.toLowerCase() === 'm') actions.mute();
  else if (k.toLowerCase() === 'k') actions.profile();
  else if (k.toLowerCase() === 'c') actions.crt();
  else return;
  e.preventDefault();
});

// ---------- Keep the screen awake while it's on ----------

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.on) {
    keepAwake();
    // Coming back to the app: catch up with the schedule, like a real TV would have.
    if (!Manage.isOpen()) tune(state.index, { quiet: true });
  }
});

// ---------- Startup ----------

async function reload() {
  state.settings = PhoneLib.settings();
  state.all = PhoneLib.tvChannels().sort((a, b) => a.number - b.number);
}

const TV = {
  // Library changed (videos added, channels edited): pick it up without losing the channel.
  async refresh() {
    await reload();
    applyProfile();
    if (state.on && !Manage.isOpen() && state.channels.length) tune(state.index, { quiet: true });
  },
  pause() {
    token++;
    teardown();
    Guide.close();
  },
  resume() {
    if (!state.on) return;
    if (!state.channels.length) return standby('NO CHANNELS', 'Open the menu to add videos');
    tune(state.index, { quiet: true });
  },
  get state() {
    return state;
  },
  osd: flashOsd,
  // For problem reports: what's on right now.
  nowPlaying() {
    if (!localNow) return null;
    const { item } = localNow.loc;
    const f = item.file;
    return `${f.show ? f.show + ': ' : ''}${f.title}${item.kind !== 'show' ? ` (${item.kind})` : ''}${f.youtube ? ` [YouTube ${f.youtube}]` : f.stream ? ' [from a PC]' : ''}`;
  },
};

async function boot() {
  await PhoneLib.load();
  await reload();
  document.body.classList.toggle('crt', store.get('crt', state.settings.crt !== false));
  const ids = Object.keys(profiles());
  state.scheduledProfile = Profiles.scheduled(state.settings);
  state.profile = [state.scheduledProfile, store.get('profile', null), state.settings.defaultProfile].find((id) => id && profiles()[id]) || ids[0] || null;
  state.channels = [];
  applyProfile();
  const i = state.channels.findIndex((c) => c.number === store.get('channel', state.settings.startChannel));
  state.index = i >= 0 ? i : 0;
  state.all.filter((c) => c.type === 'twitch').forEach(refreshStatus);
  setInterval(() => state.all.filter((c) => c.type === 'twitch').forEach(refreshStatus), 60000);
  setInterval(() => {
    const s = Profiles.scheduled(state.settings);
    if (s && s !== state.scheduledProfile) {
      state.scheduledProfile = s;
      setProfile(s);
    }
  }, 30000);
  PhoneLib.onChange(() => (Manage.isOpen() ? reload().then(applyProfile) : TV.refresh()));
  Manage.offerPairing();
  window.addEventListener('online', () => TV.refresh());
  window.addEventListener('offline', () => TV.refresh());

  // The first tap turns it on: iOS only allows sound after one.
  $('#power-on').addEventListener('click', () => {
    $('#power-on').hidden = true;
    state.on = true;
    localVideo.play().catch(() => {}); // lets this video element play with sound from now on
    keepAwake();
    Effects.power('on');
    if (!state.channels.length) return standby('NO CHANNELS', 'Tap MENU to add videos');
    tune(state.index, { quiet: true });
  });
}

boot();
