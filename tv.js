'use strict';
// The phone TV: the shared TV (src/tv-core.js, the same as the PC's) with the phone's own players
// and controls. Videos come from on-device storage or stream from a PC, YouTube plays in its
// embedded player, live channels are the sites' embeddable players, and it's driven by touch.

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

let live = null; // { frame, ch } or { youtube: true, ch }
let objectUrl = null;
let filePlay = null; // { stallTimer }

// ---------- Videos (on this device, or streamed from a PC) ----------

async function resolveUrl(file) {
  if (file.stream) return file.stream;
  const blob = await DB.blob(file.id);
  if (!blob) throw new Error('missing');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  return objectUrl;
}

async function playFile(cur, ctl) {
  stopYouTube();
  let url;
  try {
    url = await resolveUrl(cur.file);
  } catch {
    return ctl.failed('not on this device', true);
  }
  if (!ctl.current()) return;
  filePlay = { stallTimer: 0 };
  const me = filePlay;
  localVideo.onloadedmetadata = () => {
    if (!ctl.current()) return;
    localVideo.currentTime = Math.min(cur.offset, Math.max(0, (localVideo.duration || Infinity) - 1));
    play();
  };
  localVideo.onplaying = () => {
    clearTimeout(me.stallTimer);
    ctl.started();
  };
  localVideo.onwaiting = () => {
    if (!cur.ok) return;
    clearTimeout(me.stallTimer);
    me.stallTimer = setTimeout(() => ctl.current() && ctl.stalled(), 20000);
  };
  localVideo.onended = () => ctl.finished();
  localVideo.onerror = () => ctl.failed((localVideo.error && ['', 'stopped', 'network error', "couldn't decode", 'missing or unsupported'][localVideo.error.code]) || 'error', !!localVideo.error && localVideo.error.code === 3);
  localVideo.muted = tvc.state.muted;
  localVideo.src = url;
  localVideo.classList.add('on');
}

function stopItem() {
  stopYouTube();
  if (filePlay) clearTimeout(filePlay.stallTimer);
  filePlay = null;
  localVideo.onloadedmetadata = localVideo.onended = localVideo.onerror = localVideo.onplaying = localVideo.onwaiting = null;
  localVideo.pause();
  localVideo.removeAttribute('src');
  localVideo.load();
  localVideo.classList.remove('on');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
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

// ---------- YouTube ----------

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
  // Nothing to trim: YouTube's player fills the TV box and fits the video itself, the way it
  // natively fits any screen (no sizes worked out here, so nothing to get wrong on a rotation).
  if (!ytCrop) {
    for (const k of ['inset', 'width', 'height', 'left', 'top']) f.style.removeProperty(k);
    laidOut = `${cw}x${ch}|null`;
    return;
  }
  const c = ytCrop || { x: 0, y: 0, w: 1, h: 1 };
  const aspect = (c.w * 16) / (c.h * 9);
  const dw = aspect > cw / ch ? cw : ch * aspect;
  const dh = dw / aspect;
  const fw = dw / c.w;
  const fh = (fw * 9) / 16;
  Object.assign(f.style, { inset: 'auto', width: `${fw}px`, height: `${fh}px`, left: `${(cw - dw) / 2 - c.x * fw}px`, top: `${(ch - dh) / 2 - c.y * fh}px` });
  laidOut = `${cw}x${ch}|${JSON.stringify(ytCrop)}`;
}
// A safety net that doesn't rely on any event: if the box's size changed since the last layout
// (a rotation the phone didn't announce), lay out again.
let laidOut = '';
setInterval(() => {
  const host = $('#yt-host');
  if (host && !host.hidden && `${host.clientWidth}x${host.clientHeight}|${JSON.stringify(ytCrop)}` !== laidOut) layoutYouTube();
}, 1000);
// Turning the phone: iOS settles on the new size in steps, after the resize event. Lay out again
// whenever the box really changes size, and a few more times while the rotation finishes.
const relayout = () => [0, 150, 500, 1000].forEach((ms) => setTimeout(() => (unzoom(), layoutYouTube()), ms));

// iOS sometimes zooms a home-screen app in when it turns sideways, and with pinch-zoom off there's
// no way back: the picture's edges stay cut off. If the page isn't at its normal zoom, re-applying
// the viewport settings makes iOS reset it.
const viewport = document.querySelector('meta[name="viewport"]');
const viewportContent = viewport && viewport.content;
let unzooming = false;
let unzoomTries = [];
function unzoom() {
  const vv = window.visualViewport;
  if (!vv || !viewport || unzooming || Math.abs(vv.scale - 1) < 0.01) return;
  // At most three tries every five seconds, in case iOS won't let go.
  const now = Date.now();
  unzoomTries = unzoomTries.filter((t) => now - t < 5000);
  if (unzoomTries.length >= 3) return;
  unzoomTries.push(now);
  unzooming = true;
  viewport.content = viewportContent.replace('initial-scale=1', 'initial-scale=1.01');
  setTimeout(() => {
    viewport.content = viewportContent;
    window.scrollTo(0, 0);
    unzooming = false;
  }, 60);
}
window.addEventListener('resize', relayout);
window.addEventListener('orientationchange', relayout);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', relayout);
  window.visualViewport.addEventListener('scroll', unzoom);
}
matchMedia('(orientation: portrait)').addEventListener && matchMedia('(orientation: portrait)').addEventListener('change', relayout);
if (window.ResizeObserver) new ResizeObserver(() => layoutYouTube()).observe($('#yt-host'));

// YouTube's own ads. The embedded player doesn't say when one is on, but the show's clock stops
// (or its length changes to the ad's) while the player says it's playing. During one the whole
// frame is shown, not the show's crop (which would cut off the ad's Skip button), and taps go to
// the player so Skip can be tapped.
let ytAdWatch = 0;
function watchForAds(file, isCurrent) {
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
    if (on) tvc.flashOsd('COMMERCIAL', 'TAP SKIP ON THE PICTURE WHEN IT SHOWS UP', 4000);
  };
  ytAdWatch = setInterval(() => {
    if (!isCurrent() || !ytPlayer || !ytPlayer.getPlayerState) return;
    if (ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) return;
    const now = ytPlayer.getCurrentTime();
    const len = ytPlayer.getDuration();
    still = Math.abs(now - last) < 0.25 ? still + 1 : 0;
    last = now;
    const wrongLength = file.dur && len > 0 && len < 300 && Math.abs(len - file.dur) > 30;
    set(still >= 3 || wrongLength);
  }, 1000);
}

// Plays a YouTube video in the shared player. offset null = a live stream (joined live).
// on: { isCurrent(), play(), end(), error(code) }
async function ytPlay(file, offset, on) {
  const host = $('#yt-host');
  host.hidden = false;
  ytCrop = file.crop || null;
  layoutYouTube();
  watchForAds(file, on.isCurrent);
  ytHandlers = {
    state: (e) => {
      if (!on.isCurrent()) return;
      if (e.data === YT.PlayerState.ENDED) on.end();
      if (e.data === YT.PlayerState.PLAYING) {
        captionsOff();
        on.play();
      }
      // Until it plays, taps go to YouTube's own play button.
      document.body.classList.toggle('yt-tap', e.data !== YT.PlayerState.PLAYING && e.data !== YT.PlayerState.BUFFERING);
    },
    error: (e) => on.isCurrent() && on.error(e && e.data),
  };
  const start = offset == null ? undefined : Math.floor(offset);
  try {
    await loadYouTubeApi();
  } catch {
    return on.error();
  }
  if (!on.isCurrent()) return;
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
          if (tvc.state.muted) ytPlayer.mute();
        },
        onStateChange: (e) => ytHandlers.state && ytHandlers.state(e),
        onError: (e) => ytHandlers.error && ytHandlers.error(e),
      },
    });
    document.body.classList.add('yt-tap');
  } else {
    ytPlayer.loadVideoById(start != null ? { videoId: file.youtube, startSeconds: start } : { videoId: file.youtube });
    tvc.state.muted ? ytPlayer.mute() : ytPlayer.unMute();
  }
}

// A scheduled YouTube video.
function playYouTube(cur, ctl) {
  localVideo.pause();
  localVideo.classList.remove('on');
  ytPlay(cur.file, cur.offset, {
    isCurrent: ctl.current,
    play: ctl.started,
    end: ctl.finished,
    error: (code) => ctl.failed(`YouTube error ${code || ''}`.trim(), [100, 101, 150].includes(code)),
  });
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
  if (!navigator.onLine) return tvc.standby('NO SIGNAL', 'No internet. The channels on your phone still work.');
  const st = tvc.state.status.get(ch.number);
  if (st && !st.online) return tvc.offAir(ch, st);
  const isCurrent = () => t === tvc.token;
  // YouTube streams go through the same controllable player as scheduled YouTube channels
  // (captions off, swipes work once it's playing). If that stream has ended, fall back to whatever
  // the channel is streaming now.
  if (ch.type === 'youtube-live' && ch.videoId && !ch.fallback) {
    live = { youtube: true, ch };
    return ytPlay({ youtube: ch.videoId }, null, {
      isCurrent,
      play: () => tvc.health.ok('live:' + ch.number, { kind: ch.type }),
      end: () => isCurrent() && tvc.tune(tvc.state.index, { quiet: true }),
      error: () => {
        if (!isCurrent()) return;
        stopYouTube();
        playLive({ ...ch, fallback: true, videoId: null }, t);
      },
    });
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
  if (ch.type === 'twitch') tvc.refreshStatus(ch).then((s) => isCurrent() && s && !s.online && tvc.tune(tvc.state.index, { quiet: true }));
}

function stopLive() {
  if (live && live.frame) live.frame.remove();
  if (live && live.youtube) stopYouTube();
  live = null;
  document.body.classList.remove('live-on');
}

const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
async function twitchStatus(ch) {
  if (ch.type !== 'twitch' || !navigator.onLine) return null;
  try {
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_WEB_CLIENT_ID, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ query: 'query($login: String!) { user(login: $login) { stream { title } } }', variables: { login: ch.channel } }),
    });
    const user = (await res.json()).data.user;
    return !user ? { online: false, gone: true, title: '' } : { online: !!user.stream, title: user.stream ? user.stream.title : '' };
  } catch {
    return null;
  }
}

// ---------- Sound ----------

function applyVolume() {
  const muted = tvc.state.muted;
  localVideo.muted = muted;
  if (ytPlayer && ytPlayer.mute) muted ? ytPlayer.mute() : ytPlayer.unMute();
}

// ---------- The shared TV ----------

const tvc = TVCore.create({
  store,
  durationOf: (f) => f.dur || 0,
  kindOf: (f) => (f.youtube ? 'youtube' : f.stream ? 'remote' : 'file'),
  playFile,
  playYouTube,
  stopItem,
  playLive,
  stopLive,
  hasStatus: (ch) => ch.type === 'twitch',
  status: twitchStatus,
  applyVolume,
  showVolume: () => tvc.flashOsd(tvc.state.muted ? 'MUTE' : 'SOUND ON', '', 1500),
  snowVolume: () => 0.8,
  // Waiting for the viewer's first tap (iOS) isn't a video failing to start.
  waitingForViewer: () => document.body.classList.contains('yt-tap') || !$('#tap-play').hidden,
  noShows: () => ['NO SHOWS YET', 'Add videos in the menu'],
  guide: { scroll: true },
  healthLimit: 300,
});
tvc.state.on = false; // powered on (the first tap done)

// ---------- Profiles and PIN (touch) ----------

const menu = $('#menu');
const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });

function closeMenu() {
  menu.hidden = true;
  menu.replaceChildren();
}

// On-screen PIN pad. Resolves true for the right PIN; no PIN set means no lock.
function askPin(reason) {
  const pin = String(tvc.state.settings.pin || '');
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
  const profiles = tvc.profiles();
  const ids = Object.keys(profiles);
  if (!ids.length) return tvc.flashOsd('NO PROFILES', '', 2000);
  menu.replaceChildren(el('h2', '', "WHO'S WATCHING?"));
  for (const id of ids) {
    const prof = profiles[id];
    const b = el('button', 'choice', `${(prof.label || id).toUpperCase()}${prof.locked ? '  (PIN)' : ''}${id === tvc.state.profile ? '  <' : ''}`);
    b.addEventListener('click', async () => {
      closeMenu();
      if (id === tvc.state.profile) return;
      if (prof.locked && !(await askPin(`UNLOCK ${(prof.label || id).toUpperCase()}`))) return;
      tvc.setProfile(id);
    });
    menu.append(b);
  }
  const cancel = el('button', 'hint', 'Cancel');
  cancel.addEventListener('click', closeMenu);
  menu.append(cancel);
  menu.hidden = false;
}

// ---------- Remote: buttons, number pad, swipes ----------

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
  up: () => tvc.tune(tvc.state.index + 1),
  down: () => tvc.tune(tvc.state.index - 1),
  last: () => tvc.state.last != null && tvc.tune(tvc.state.last),
  guide: () => (Guide.isOpen() ? Guide.close() : Guide.open(tvc.guideApi())),
  info: () => tvc.showBanner(),
  mute: () => tvc.toggleMute(),
  profile: () => openProfileMenu(),
  crt: () => {
    const on = !document.body.classList.contains('crt');
    document.body.classList.toggle('crt', on);
    store.set('crt', on);
  },
  menu: async () => {
    if (await askPin('MENU')) Manage.open();
  },
  order: () => tvc.toggleOrder(),
  // No PIN: anyone watching can say something's wrong.
  report: () => Report.open(),
};
document.body.classList.toggle('no-report', !Report.enabled);

document.querySelectorAll('[data-act]').forEach((b) =>
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!tvc.state.on) return;
    remoteShown();
    actions[b.dataset.act]();
  })
);
document.querySelectorAll('[data-digit]').forEach((b) =>
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    remoteShown();
    tvc.typeDigit(b.dataset.digit);
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
  if (!touch || !tvc.state.on) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  touch = null;
  if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.5) {
    if (Guide.isOpen()) Guide.scrollBy(dy < 0 ? 1 : -1);
    else tvc.tune(tvc.state.index + (dy < 0 ? 1 : -1));
  } else if (Math.abs(dx) < 15 && Math.abs(dy) < 15 && !Guide.isOpen()) {
    tvc.showBanner();
    remoteShown();
  }
});
// Keyboards (an iPad with a keyboard) get the PC's keys.
document.addEventListener('keydown', (e) => {
  if (!tvc.state.on || !menu.hidden || Manage.isOpen()) return;
  if (Guide.isOpen() && Guide.key(e)) return;
  const k = e.key;
  if (k === 'ArrowUp' || k === 'PageUp') actions.up();
  else if (k === 'ArrowDown' || k === 'PageDown') actions.down();
  else if (/^[0-9]$/.test(k)) tvc.typeDigit(k);
  else if (k === 'Enter' && tvc.enterDigits()) {
    // tuned to the typed number
  } else if (k === 'Backspace') actions.last();
  else if (k.toLowerCase() === 'g') actions.guide();
  else if (k.toLowerCase() === 'i' || k === 'Enter') actions.info();
  else if (k.toLowerCase() === 'm') actions.mute();
  else if (k.toLowerCase() === 'k') actions.profile();
  else if (k.toLowerCase() === 'c') actions.crt();
  else if (k.toLowerCase() === 'o') actions.order();
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
  if (document.visibilityState === 'visible' && tvc.state.on) {
    keepAwake();
    // Coming back to the app: catch up with the schedule, like a real TV would have.
    if (!Manage.isOpen()) tvc.tune(tvc.state.index, { quiet: true });
  }
});

// ---------- Startup ----------

async function reload() {
  tvc.setLineup(PhoneLib.settings(), PhoneLib.tvChannels());
}

// For the menu, updates and problem reports.
const TV = {
  // Library changed (videos added, channels edited): pick it up without losing the channel.
  async refresh() {
    await reload();
    tvc.applyProfile();
    if (tvc.state.on && !Manage.isOpen() && tvc.state.channels.length) tvc.tune(tvc.state.index, { quiet: true });
  },
  pause() {
    tvc.invalidate();
    tvc.teardown();
    Guide.close();
  },
  resume() {
    if (!tvc.state.on) return;
    if (!tvc.state.channels.length) return tvc.standby('NO CHANNELS', 'Open the menu to add videos');
    tvc.tune(tvc.state.index, { quiet: true });
  },
  get state() {
    return tvc.state;
  },
  osd: (...a) => tvc.flashOsd(...a),
  nowPlaying: () => tvc.nowPlaying(),
};

async function boot() {
  await PhoneLib.load();
  await reload();
  document.body.classList.toggle('crt', store.get('crt', tvc.state.settings.crt !== false));
  tvc.start();
  PhoneLib.onChange(() => (Manage.isOpen() ? reload().then(() => tvc.applyProfile()) : TV.refresh()));
  Manage.offerPairing();
  window.addEventListener('online', () => TV.refresh());
  window.addEventListener('offline', () => TV.refresh());

  // The first tap turns it on: iOS only allows sound after one.
  $('#power-on').addEventListener('click', () => {
    $('#power-on').hidden = true;
    tvc.state.on = true;
    localVideo.play().catch(() => {}); // lets this video element play with sound from now on
    keepAwake();
    Effects.power('on');
    if (!tvc.state.channels.length) return tvc.standby('NO CHANNELS', 'Tap MENU to add videos');
    tvc.tune(tvc.state.index, { quiet: true });
  });
}

boot();
