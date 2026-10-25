'use strict';
// The TV itself, shared by the PC (src/app.js) and the phone (mobile/tv.js): the lineup and
// profiles, tuning and surfing, scheduled playback with recovery (src/health.js), the banner, the
// channel-number display, standby cards, the guide's listings, ORDER and mute. Each side brings
// the players for its own world (webviews and files on the PC; embedded players, on-device videos
// and touch on the phone) as `platform`:
//
//   store                    saved settings: get(key, default) / set(key, value)
//   durationOf(file)         a video's length in seconds (0: unknown)
//   kindOf(file)             'file' | 'remote' | 'youtube' (for health records)
//   prepare(ch, t)           optional, async: get a scheduled channel ready (the PC measures lengths)
//   playFile(cur, ctl)       play a video file in the slot `cur` describes
//   playYouTube(cur, ctl)    play a scheduled YouTube video
//   stopItem()               stop whatever a scheduled channel is playing
//   playLive(ch, t)          play a live channel (a site's own player)
//   stopLive()               and stop it
//   hasStatus(ch)            optional: whether status(ch) can say if a live channel is on the air
//   status(ch, force)        optional, async: { online, title, gone } or null (force: ask afresh)
//   applyVolume()            push state.volume / state.muted to the players
//   showVolume()             show the volume (or MUTE) on screen
//   snowVolume()             how loud the static between channels is
//   waitingForViewer()       optional: true while a player waits for the viewer's first tap
//   noShows(ch)              [big, small] standby text for a channel with nothing to play
//   lineupChanged()          optional: after the lineup or profile changes
//   reportHealth(report)     optional: hand the health report on (to the Library)
//   guide                    extra options for the guide (the phone's scrolls)
//   healthLimit              how many health records to keep
//
// Players report back through `ctl`: started(), failed(reason, permanent), finished(), stalled(),
// and current() says whether the slot is still the one on screen.

const TVCore = (() => {
  const $ = (s) => document.querySelector(s);
  const showLabel = (p) => (p.show && p.show !== p.title && !p.title.startsWith(p.show) ? `${p.show}: ${p.title}` : p.title);
  const keyOf = (f) => f.key || f.url;
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Keep the TV box and the picture from ever being scrolled (see style.css).
  for (const sel of ['#tv', '#screen']) {
    const box = $(sel);
    if (!box) continue;
    const pin = () => {
      if (box.scrollTop || box.scrollLeft) box.scrollTop = box.scrollLeft = 0;
    };
    box.addEventListener('scroll', pin);
    window.addEventListener('resize', pin);
  }

  function create(platform) {
    const p = platform;
    const store = p.store;
    const state = {
      settings: {},
      all: [], // every channel
      channels: [], // what the current profile can see, in channel order
      profile: null,
      scheduledProfile: null,
      index: 0,
      last: null,
      volume: store.get('volume', 0.8),
      muted: false,
      cycles: new Map(), // channel number -> schedule
      status: new Map(), // channel number -> { online, title, gone } for live channels
    };
    let token = 0; // bumps on every tune, so stale callbacks know to give up
    let localNow = null; // what a scheduled channel is showing: { ch, loc, file, sub, slotStart, slotEnd }
    let liveOn = null; // the live channel on screen
    let blockTimer = 0;
    let slotTimer = 0;
    let loadTimer = 0;
    let startTimer = 0;
    // Surfing: the channel number and static show at once, but the player only starts once the
    // viewer has stayed on a channel this long (the static covers the wait). Pressing CH up five
    // times quickly loads one channel, not five.
    const SETTLE = 350;

    // ---------- Health (src/health.js) ----------

    const health = Health.monitor({ records: store.get('health', {}) });
    const played = store.get('played', []); // what actually aired, stand-ins included, newest last
    let lastLogged = '';

    function logAired(ch, scheduled, file, reason, copy) {
      const id = `${ch.number}|${keyOf(scheduled)}|${keyOf(file)}`;
      if (id === lastLogged) return;
      lastLogged = id;
      played.push({ at: Date.now(), ch: ch.number, scheduled: scheduled.title, aired: file.title, standIn: (file !== scheduled && !copy) || undefined, copy: copy || undefined, reason: reason || undefined });
      if (played.length > 200) played.splice(0, played.length - 200);
      store.set('played', played);
    }

    function channelHealth(ch) {
      if (ch.type === 'local') return health.channelStatus(ch.episodes.map(keyOf));
      return health.status('live:' + ch.number);
    }

    // Saved (and handed to the Library on the PC) a few seconds after anything changes.
    setInterval(() => {
      if (!health.takeChanged()) return;
      store.set('health', health.all(p.healthLimit || 800));
      if (!p.reportHealth) return;
      p.reportHealth({
        at: Date.now(),
        channels: state.all.map((ch) => {
          const keys = ch.type === 'local' ? ch.episodes.map(keyOf) : ['live:' + ch.number];
          const recs = keys.map((k) => health.get(k)).filter(Boolean);
          const bad = recs.filter((r) => r.failures > 0);
          const starts = recs.map((r) => r.loadMs).filter((ms) => ms > 0).sort((a, b) => a - b);
          return {
            number: ch.number,
            status: channelHealth(ch),
            sources: keys.length,
            failing: bad.length,
            // Typical time from tuning in to the picture starting (the median of its sources).
            startMs: starts.length ? starts[Math.floor(starts.length / 2)] : null,
            lastOk: Math.max(0, ...recs.map((r) => r.lastOk || 0)) || null,
            lastFail: Math.max(0, ...recs.map((r) => r.lastFail || 0)) || null,
            lastError: (bad.sort((a, b) => b.lastFail - a.lastFail)[0] || {}).lastError || null,
          };
        }),
        aired: played.slice(-40),
      });
    }, 5000);

    // ---------- Schedules ----------

    // Scheduled channels as the current profile sees them, by number (time blocks can borrow
    // another channel's shows, even one the profile doesn't list).
    const viewed = new Map();
    const lookup = (n) => viewed.get(n) || null;

    function cycleFor(ch) {
      if (!state.cycles.has(ch.number)) {
        const breaks = { bumpers: 1, commercials: 3, ...(state.settings.breaks || {}), ...(ch.breaks || {}) };
        state.cycles.set(ch.number, Schedule.build(withOrder(ch), p.durationOf, breaks, lookup));
      }
      return state.cycles.get(ch.number);
    }

    // Sports and wrestling channels ("order": "grouped") play in history order or at random; ORDER
    // switches the channel you're on. Series and events stay in order either way.
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

    // Guide listings: the same schedule the TV plays, with the current slot's stand-in if any.
    function listings(ch, from, to) {
      if (ch.type === 'local') {
        const sub = localNow && localNow.ch.number === ch.number && localNow.sub ? localNow : null;
        return Schedule.listings(cycleFor(ch), from, to).map((l) =>
          sub && Math.abs(l.start - sub.slotStart) < 2000 ? { ...l, title: `${showLabel(sub.file)} (stand-in)`, substituted: true } : { ...l, title: showLabel(l) }
        );
      }
      if (!navigator.onLine) return [{ live: true, off: true, title: 'No signal: the internet is down', start: from, end: to }];
      const st = state.status.get(ch.number);
      const off = !!st && !st.online;
      return [{ live: true, off, title: (!off && st && st.title) || ch.description || ch.name, start: from, end: to }];
    }

    const guideApi = () => ({ channels: state.channels, current: () => state.index, listings, tune: (i) => tune(i), ...(p.guide || {}) });

    // ---------- Tuning ----------

    function standby(big, small = '') {
      const el = $('#standby');
      el.hidden = !big;
      if (big) {
        el.querySelector('.big').textContent = big;
        el.querySelector('.small').textContent = small;
      }
    }

    const offAir = (ch, st) => standby('OFF THE AIR', st.gone ? `${ch.name} has signed off for good` : `${ch.name} isn't broadcasting right now`);

    function stopItem() {
      clearTimeout(loadTimer);
      p.stopItem();
    }

    function teardown() {
      clearTimeout(blockTimer);
      clearTimeout(slotTimer);
      if (liveOn) p.stopLive();
      liveOn = null;
      stopItem();
      localNow = null;
      standby(null);
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
      Effects.snow(quiet ? 300 : 650, state.muted ? 0 : p.snowVolume());
      teardown();
      showOsd(ch);
      clearTimeout(startTimer);
      const begin = () => {
        if (t !== token) return;
        if (ch.type === 'local') playLocal(ch, t);
        else {
          liveOn = ch;
          p.playLive(ch, t);
        }
      };
      if (quiet) begin();
      else startTimer = setTimeout(begin, SETTLE);
      setTimeout(() => t === token && showBanner(), 700);
    }

    function tuneNumber(num) {
      const i = state.channels.findIndex((c) => c.number === num);
      if (i >= 0) tune(i);
      else flashOsd(String(num).padStart(2, '0'), 'NO SIGNAL');
    }

    let digits = '';
    let digitTimer = 0;
    function typeDigit(d) {
      digits += d;
      flashOsd(`CH ${digits.padEnd(2, '-')}`, '', 2000);
      clearTimeout(digitTimer);
      const maxNum = Math.max(...state.channels.map((c) => c.number));
      if (Number(digits + '0') > maxNum || digits.length >= 3) enterDigits();
      else digitTimer = setTimeout(enterDigits, 1500);
    }
    // Enter (or the wait running out) tunes to the typed number. False if nothing was typed.
    function enterDigits() {
      clearTimeout(digitTimer);
      if (!digits) return false;
      const n = Number(digits);
      digits = '';
      tuneNumber(n);
      return true;
    }

    // ---------- Scheduled channels ----------

    async function playLocal(ch, t) {
      if (!ch.episodes.length) return standby(...p.noShows(ch));
      if (p.prepare) await p.prepare(ch, t);
      if (t !== token) return;
      standby(null);
      playLocalAt(ch, Date.now(), t);
    }

    // Other copies of the scheduled episode (from the catalog) that aren't resting after a failure.
    const copiesOf = (f) => (f.alternates || []).filter((a) => health.usable(keyOf(a)));

    // Plays what the schedule says is on at `at`. opts (from recovery): { file, offset } plays that
    // instead in this slot (copy: it's another copy of the same episode, not a stand-in); retries /
    // tried count what's been attempted for it.
    function playLocalAt(ch, at, t, opts = {}) {
      clearTimeout(blockTimer);
      clearTimeout(slotTimer);
      const loc = Schedule.locate(cycleFor(ch), at);
      if (!loc) return standby('NO SIGNAL', "None of this channel's videos would play");
      const scheduled = loc.item.file;
      const slotStart = Math.round(at - loc.offset * 1000);
      const slotEnd = slotStart + Math.round(loc.item.dur * 1000);
      const cur = { ch, t, loc, scheduled, slotStart, slotEnd, retries: opts.retries || 0, copy: !!opts.copy, tried: opts.tried || [], reason: opts.reason };
      cur.file = opts.file || scheduled;
      cur.offset = opts.file ? opts.offset || 0 : loc.offset;
      // The scheduled source failed recently and is resting: go straight to another copy of it, or
      // a stand-in.
      if (!opts.file && !opts.force && !health.usable(keyOf(scheduled))) {
        const copy = copiesOf(scheduled)[0];
        const sub = copy ? null : standIn(cur, []);
        if (!copy && !sub) return standbyUntil(cur);
        cur.file = copy || sub.file;
        cur.offset = copy ? loc.offset : sub.offset;
        cur.copy = !!copy;
        cur.reason = 'scheduled video is unavailable';
      }
      const standingIn = cur.file !== scheduled && !cur.copy;
      localNow = { ch, loc, file: cur.file, sub: standingIn ? { original: scheduled } : null, slotStart, slotEnd };
      if (loc.item.kind === 'show') logAired(ch, scheduled, cur.file, cur.reason, cur.copy);
      // A time block starting (or ending) mid-show cuts over, like the real schedule did.
      const untilSwitch = loc.contextEnd - Date.now();
      if (untilSwitch < (loc.item.dur - loc.offset) * 1000 && untilSwitch < 2 ** 31 - 1) {
        blockTimer = setTimeout(() => t === token && playLocalAt(ch, Date.now() + 250, t), Math.max(0, untilSwitch) + 100);
      }
      // A stand-in (or another copy) only fills its slot; then the schedule carries on as planned.
      if (cur.file !== scheduled) slotTimer = setTimeout(() => t === token && playLocalAt(ch, Date.now() + 250, t), Math.max(0, slotEnd - Date.now()) + 100);
      stopItem();
      standby(null);
      const started = Date.now();
      const ctl = {
        current: () => t === token && !cur.done,
        started: () => {
          if (!ctl.current() || cur.ok) return;
          cur.ok = true;
          clearTimeout(loadTimer);
          health.ok(keyOf(cur.file), { loadMs: Date.now() - started, kind: p.kindOf(cur.file) });
        },
        failed: (reason, permanent) => recover(cur, reason, permanent),
        stalled: () => {
          health.stall(keyOf(cur.file));
          recover(cur, 'stalled while playing');
        },
        finished: () => finished(cur),
      };
      // Not started after a while: a hiccup, like an error. Waiting for the viewer's first tap
      // (iOS needs one before anything plays with sound) doesn't count.
      const watchStart = () => {
        loadTimer = setTimeout(() => {
          if (!ctl.current() || cur.ok) return;
          if (p.waitingForViewer && p.waitingForViewer()) return watchStart();
          recover(cur, 'took too long to start');
        }, cur.file.youtube ? 30000 : 25000);
      };
      watchStart();
      if (cur.file.youtube) p.playYouTube(cur, ctl);
      else p.playFile(cur, ctl);
      if (loc.item.kind === 'show' && cur.offset < 2) setTimeout(() => t === token && showBanner(), cur.file.youtube ? 1500 : 1000);
    }

    // A stand-in for the slot: the same show first, then the channel's other programs of that kind
    // (episodes for episodes, ads for ads). It joins in progress if it's long enough.
    function standIn(cur, exclude) {
      const kind = cur.loc.item.kind;
      const pool = (kind === 'bumper' ? cur.ch.bumpers : kind === 'commercial' ? cur.ch.commercials : cur.ch.episodes).map((f) => ({ ...f, dur: p.durationOf(f) }));
      const pick = Health.substitute(cur.scheduled, pool, { usable: health.usable, seed: `${cur.ch.number}|${cur.slotStart}`, exclude: [...cur.tried, ...exclude] });
      if (!pick) return null;
      const all = kind === 'bumper' ? cur.ch.bumpers : kind === 'commercial' ? cur.ch.commercials : cur.ch.episodes;
      const file = all.find((f) => keyOf(f) === keyOf(pick)) || pick;
      const elapsed = (Date.now() - cur.slotStart) / 1000;
      return { file, offset: pick.dur > elapsed + 30 ? Math.max(0, elapsed) : 0 };
    }

    // Nothing left to play in this slot: a standby card until the next one.
    function standbyUntil(cur) {
      localNow = { ch: cur.ch, loc: cur.loc, file: cur.scheduled, sub: null, slotStart: cur.slotStart, slotEnd: cur.slotEnd };
      stopItem();
      standby('PLEASE STAND BY', "We'll be right back");
      slotTimer = setTimeout(() => cur.t === token && playLocalAt(cur.ch, Date.now() + 250, cur.t), Math.max(0, cur.slotEnd - Date.now()) + 100);
    }

    // Something in a slot failed: try again, another copy of it, or a stand-in (see src/health.js).
    function recover(cur, reason, permanent = false) {
      if (cur.t !== token || cur.done) return;
      cur.done = true;
      clearTimeout(loadTimer);
      const { ch, t } = cur;
      health.fail(keyOf(cur.file), { reason, permanent, kind: p.kindOf(cur.file) });
      const tried = [...cur.tried, keyOf(cur.file)];
      // Only the scheduled file is retried, and only the episode (not a stand-in) has copies.
      const isScheduled = cur.file === cur.scheduled;
      const copies = isScheduled || cur.copy ? copiesOf(cur.scheduled).filter((a) => !tried.includes(keyOf(a))) : [];
      const step = Health.nextStep({ retries: isScheduled ? cur.retries : Infinity, permanent, alternates: copies.length });
      if (step === 'retry') return playLocalAt(ch, Date.now(), t, { retries: cur.retries + 1, force: true, reason });
      if (step === 'alternate') {
        return playLocalAt(ch, Date.now(), t, { file: copies[0], copy: true, offset: (Date.now() - cur.slotStart) / 1000, tried, retries: cur.retries, reason });
      }
      const sub = standIn(cur, [keyOf(cur.file)]);
      if (!sub) return standbyUntil(cur);
      playLocalAt(ch, Date.now(), t, { file: sub.file, offset: sub.offset, tried, retries: 99, reason });
    }

    // Whatever was playing in the slot finished. A stand-in shorter than its slot hands over to
    // another one; otherwise the schedule moves on.
    function finished(cur) {
      if (cur.t !== token || cur.done) return;
      cur.done = true;
      clearTimeout(loadTimer);
      health.ok(keyOf(cur.file), { kind: p.kindOf(cur.file) });
      if (cur.file !== cur.scheduled && Date.now() < cur.slotEnd - 3000) {
        const sub = standIn(cur, [keyOf(cur.file)]);
        if (!sub) return standbyUntil(cur);
        return playLocalAt(cur.ch, Date.now(), cur.t, { file: sub.file, offset: 0, tried: [...cur.tried, keyOf(cur.file)], retries: 99, reason: cur.reason });
      }
      playLocalAt(cur.ch, Date.now() + 750, cur.t);
    }

    // For problem reports: what's on right now.
    function nowPlaying() {
      if (!localNow) return liveOn ? `${liveOn.name} (live)` : null;
      const { item } = localNow.loc;
      const f = localNow.file || item.file;
      return `${f.show ? f.show + ': ' : ''}${f.title}${item.kind !== 'show' ? ` (${item.kind})` : ''}${f.youtube ? ` [YouTube ${f.youtube}]` : f.stream ? ' [from a PC]' : ''}${localNow.sub ? ` standing in for ${localNow.sub.original.title}` : ''}`;
    }

    // ---------- Sound ----------

    function toggleMute() {
      state.muted = !state.muted;
      p.applyVolume();
      p.showVolume();
    }

    function changeVolume(d) {
      state.muted = false;
      state.volume = Math.round(Math.min(1, Math.max(0, state.volume + d)) * 20) / 20;
      store.set('volume', state.volume);
      p.applyVolume();
      p.showVolume();
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

    // ---------- Live channels' on-air status ----------

    async function refreshStatus(ch, force = false) {
      if (!p.status) return null;
      const s = await p.status(ch, force);
      if (s) state.status.set(ch.number, s);
      return s;
    }

    // ---------- Lineup and profiles ----------

    const profiles = () => state.settings.profiles || {};
    const currentProfile = () => profiles()[state.profile] || null;

    function setLineup(settings, channels) {
      state.settings = settings || {};
      state.all = channels.slice().sort((a, b) => a.number - b.number);
    }

    // Rebuild the visible lineup for the current profile, staying on the same channel if possible.
    function applyProfile() {
      const prof = currentProfile();
      const curNum = state.channels[state.index] && state.channels[state.index].number;
      viewed.clear();
      for (const ch of state.all) {
        if (ch.type === 'local') viewed.set(ch.number, { ...ch, episodes: ch.episodes.filter((f) => Profiles.allowsFile(prof, f, ch)) });
      }
      // Scheduled channels with nothing (watchable) in them stay off the dial.
      state.channels = state.all
        .map((ch) => (ch.type === 'local' ? viewed.get(ch.number) : ch))
        .filter((ch) => Profiles.allowsChannel(prof, ch) && (ch.type !== 'local' || ch.episodes.length));
      state.cycles.clear();
      if (p.lineupChanged) p.lineupChanged();
      const i = state.channels.findIndex((c) => c.number === curNum);
      state.index = i >= 0 ? i : 0;
      state.last = null;
      return i >= 0;
    }

    function setProfile(id, { announce = true } = {}) {
      if (!profiles()[id]) return;
      state.profile = id;
      store.set('profile', id);
      const kept = applyProfile();
      if (announce) flashOsd(profiles()[id].label || id.toUpperCase(), 'PROFILE', 3000);
      if (!state.channels.length) {
        teardown();
        return standby('NO CHANNELS', 'This profile has no channels with anything to watch');
      }
      if (!kept || !(localNow || liveOn)) tune(state.index, { quiet: true });
    }

    // Power-on: the profile (the profile schedule wins, then the last one used, then the default),
    // the starting channel, and the timers that keep both current.
    function start() {
      const ids = Object.keys(profiles());
      state.scheduledProfile = Profiles.scheduled(state.settings);
      state.profile = [state.scheduledProfile, store.get('profile', null), state.settings.defaultProfile].find((id) => id && profiles()[id]) || ids[0] || null;
      state.channels = [];
      applyProfile();
      const i = state.channels.findIndex((c) => c.number === store.get('channel', state.settings.startChannel));
      state.index = i >= 0 ? i : 0;
      setInterval(() => {
        const s = Profiles.scheduled(state.settings);
        if (s && s !== state.scheduledProfile) {
          state.scheduledProfile = s;
          setProfile(s);
        }
      }, 30000);
      const refreshAll = () => state.all.filter((c) => c.type !== 'local' && p.hasStatus && p.hasStatus(c)).forEach(refreshStatus);
      refreshAll();
      setInterval(refreshAll, 60000);
    }

    return {
      state,
      health,
      played,
      keyOf,
      showLabel,
      get token() {
        return token;
      },
      // Cancels whatever is playing (the phone's menu takes over the screen).
      invalidate: () => ++token,
      get localNow() {
        return localNow;
      },
      get liveOn() {
        return liveOn;
      },
      cycleFor,
      listings,
      guideApi,
      tune,
      tuneNumber,
      typeDigit,
      enterDigits,
      toggleOrder,
      toggleMute,
      changeVolume,
      standby,
      offAir,
      flashOsd,
      showBanner,
      teardown,
      refreshStatus,
      profiles,
      currentProfile,
      setLineup,
      applyProfile,
      setProfile,
      start,
      nowPlaying,
    };
  }

  return { create, showLabel };
})();
