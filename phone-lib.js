'use strict';
// The phone's library: channels, settings and video details from on-device storage, turned
// into the same channel objects the desktop TV uses (so Schedule, Guide and Profiles are shared).
// RTV_DEFAULTS (config.js) is generated from the desktop's channels.json and channel.json files.

const PhoneLib = (() => {
  const D = window.RTV_DEFAULTS;
  let channels = [];
  let settings = {};
  let entries = [];
  const listeners = new Set();

  // The home server: a Retro TV PC sharing the shows on its drive. Paired once with its passcode.
  let home = null; // { url, token, name } once paired
  let homeHere = null; // { url, name } when this page itself comes from a Retro TV PC
  let homeLineup = null; // the PC's last lineup (kept so the guide works while it's off)
  let homeUp = false; // the PC answered the last time we asked

  function timed(url, opts = {}, ms = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { ...opts, cache: 'no-store', signal: ctl.signal }).finally(() => clearTimeout(timer));
  }

  async function load() {
    channels = (await DB.get('channels')) || D.channels.map((c) => ({ ...c }));
    settings = { ...D.settings, ...((await DB.get('settings')) || {}) };
    entries = await DB.entries();
    home = (await DB.get('home')) || null;
    homeLineup = (await DB.get('homeLineup')) || null;
    // Opened from the PC's own address?
    if (!/github\.io$/.test(location.hostname)) try {
      const r = await timed('api/hello', {}, 3000);
      const j = r.ok ? await r.json() : null;
      if (j && j.app === 'retro-tv-home') homeHere = { url: new URL('.', location.href).href.replace(/\/$/, ''), name: j.name, open: !!j.open };
    } catch {}
    // No passcode needed: the PC this page came from, or the one the website shares with everyone.
    if (!home && homeHere && homeHere.open) home = { url: homeHere.url, token: '', name: homeHere.name, shared: true };
    if (!home && settings.publicServer) home = { url: String(settings.publicServer).replace(/\/+$/, ''), token: '', name: 'Shared shows', shared: true };
    if (home) await refreshHome(false);
    setInterval(() => refreshHome(), 5 * 60000);
    window.addEventListener('online', () => refreshHome());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshHome());
  }

  // Asks the PC for its lineup. Only tells the TV when something changed (it retunes).
  async function refreshHome(notify = true) {
    if (!home) return 'unpaired';
    const before = JSON.stringify([homeUp, homeLineup]);
    let result = 'ok';
    try {
      const r = await timed(home.url + '/api/lineup', { headers: { Authorization: 'Bearer ' + home.token } });
      if (r.status === 401 && home.shared) {
        // A shared PC that started asking for a passcode: its shows are just off for now.
        homeUp = false;
        result = 'unpaired';
      } else if (r.status === 401) {
        // The PC forgot this phone (or got a new passcode and was told to forget it).
        home = null;
        homeUp = false;
        await DB.set('home', null);
        result = 'unpaired';
      } else if (!r.ok) {
        throw new Error(String(r.status));
      } else {
        homeLineup = await r.json();
        homeUp = true;
        if (homeLineup.name) home.name = homeLineup.name;
        await DB.set('homeLineup', homeLineup);
      }
    } catch {
      homeUp = false;
      result = 'unreachable';
    }
    if (notify && JSON.stringify([homeUp, homeLineup]) !== before) changed();
    return result;
  }

  async function pairHome(url, code) {
    url = String(url).trim().replace(/\/+$/, '');
    let r;
    try {
      r = await timed(url + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ code, device: deviceName() }) });
    } catch {
      throw new Error("Couldn't reach the PC. Is it on, with the home server turned on?");
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `The PC answered ${r.status}`);
    home = { url, token: j.token, name: j.name || 'PC' };
    await DB.set('home', home);
    await refreshHome(false);
    changed();
    return home;
  }

  async function forgetHome() {
    home = null;
    homeUp = false;
    homeLineup = null;
    await DB.set('home', null);
    await DB.set('homeLineup', null);
    changed();
  }

  function deviceName() {
    const ua = navigator.userAgent;
    return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Browser';
  }

  const changed = () => listeners.forEach((fn) => fn());

  async function saveChannels(next) {
    channels = next.slice().sort((a, b) => a.number - b.number);
    await DB.set('channels', channels);
    changed();
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    const own = { ...((await DB.get('settings')) || {}), ...patch };
    await DB.set('settings', own);
    changed();
  }

  async function putEntry(e) {
    await DB.putEntry(e);
    entries = entries.filter((x) => x.id !== e.id).concat(e);
    changed();
  }

  async function removeEntry(id) {
    await DB.deleteEntry(id);
    entries = entries.filter((x) => x.id !== id);
    changed();
  }

  // A video as the scheduler sees it. Streaming entries need the internet.
  function file(e, ch) {
    return {
      url: 'rtv:' + e.id,
      key: e.id,
      id: e.id,
      title: e.title || e.name,
      show: e.show || '',
      broadcast: !!e.broadcast || (ch && ch.mode === 'broadcast'),
      airDate: e.airDate || null,
      year: e.year || null,
      network: e.network || null,
      rating: e.rating || null,
      dur: e.duration || 0,
      stream: e.kind === 'stream' ? e.url : null,
    };
  }

  function tvChannels() {
    const online = navigator.onLine;
    const usable = entries.filter((e) => e.duration > 0 && (e.kind !== 'stream' || online));
    const shared = (role) => usable.filter((e) => e.role === role && e.channel == null).map((e) => file(e));
    const sharedBumpers = shared('bumper');
    const sharedCommercials = shared('commercial');
    const locals = channels.map((c) => {
      const mine = usable.filter((e) => e.channel === c.number);
      const pick = (role) => mine.filter((e) => e.role === role).map((e) => file(e, c));
      const bumpers = pick('bumper');
      const commercials = pick('commercial');
      return {
        type: 'local',
        number: c.number,
        name: c.name,
        order: c.order || settings.localOrder || 'shuffle',
        mode: c.mode || 'episodes',
        breaks: c.breaks || null,
        blocks: Array.isArray(c.blocks) ? c.blocks : [],
        rating: c.rating || null,
        description: c.description || '',
        episodes: pick('show'),
        bumpers: bumpers.length ? bumpers : sharedBumpers,
        commercials: commercials.length ? commercials : sharedCommercials,
      };
    });
    // Shows on the PC's drive, streamed from it while it's reachable.
    const pc = home && homeUp && homeLineup ? homeLineup.channels || [] : [];
    const fromPc = (list) =>
      (list || []).map((v) => ({
        url: 'home:' + v.id,
        key: 'home:' + v.id,
        id: v.id,
        title: v.title,
        show: v.show || '',
        broadcast: !!v.broadcast,
        airDate: v.airDate || null,
        year: v.year || null,
        network: v.network || null,
        rating: v.rating || null,
        dur: v.dur,
        stream: `${home.url}/media/${v.id}?k=${encodeURIComponent(home.token)}`,
      }));
    for (const ch of locals) {
      const p = pc.find((c) => c.number === ch.number);
      if (!p) continue;
      ch.episodes = ch.episodes.concat(fromPc(p.episodes));
      if (ch.bumpers === sharedBumpers && p.bumpers.length) ch.bumpers = fromPc(p.bumpers);
      if (ch.commercials === sharedCommercials && p.commercials.length) ch.commercials = fromPc(p.commercials);
    }
    // PC channels the phone doesn't have yet.
    const taken = new Set([...locals, ...D.live, ...(D.youtubeLive || []), ...(D.youtube || [])].map((c) => c.number));
    const pcOnly = pc
      .filter((p) => !taken.has(p.number) && p.episodes.length)
      .map((p) => ({
        type: 'local',
        source: 'home',
        number: p.number,
        name: p.name,
        order: p.order || settings.localOrder || 'shuffle',
        mode: p.mode || 'episodes',
        breaks: p.breaks || null,
        blocks: p.blocks || [],
        rating: p.rating || null,
        description: p.description || '',
        episodes: fromPc(p.episodes),
        bumpers: p.bumpers.length ? fromPc(p.bumpers) : sharedBumpers,
        commercials: p.commercials.length ? fromPc(p.commercials) : sharedCommercials,
      }));
    // YouTube channels come pre-built from the PC (the phone can't read YouTube pages itself).
    const yt = (D.youtube || []).map((c) => {
      const f = (v) => ({ url: 'yt:' + v.id, key: 'yt:' + v.id, id: v.id, youtube: v.id, title: v.title, show: v.show || '', dur: v.dur, broadcast: c.mode === 'broadcast', crop: v.crop || null, group: v.group ?? null, part: v.part ?? null, when: v.when || null });
      const bumpers = (c.bumpers || []).map(f);
      const commercials = (c.commercials || []).map(f);
      return {
        type: 'local',
        source: 'youtube',
        number: c.number,
        name: c.name,
        order: c.order || 'shuffle',
        groupOrder: c.groupOrder || null,
        historyOrder: c.historyOrder || null,
        mode: c.mode || 'episodes',
        breaks: c.breaks || null,
        blocks: Array.isArray(c.blocks) ? c.blocks : [],
        rating: c.rating || null,
        description: c.description || '',
        episodes: online ? c.episodes.map(f) : [],
        bumpers: bumpers.length ? bumpers : sharedBumpers,
        commercials: commercials.length ? commercials : sharedCommercials,
      };
    });
    return [...D.live.map((c) => ({ ...c })), ...(D.youtubeLive || []).map((c) => ({ ...c })), ...yt, ...locals, ...pcOnly];
  }

  return {
    load,
    tvChannels,
    channels: () => channels,
    settings: () => settings,
    entries: () => entries,
    saveChannels,
    saveSettings,
    putEntry,
    removeEntry,
    onChange: (fn) => listeners.add(fn),
    home: () => ({ paired: home ? { name: home.name, url: home.url, shared: !!home.shared } : null, here: homeHere, up: homeUp, lineup: homeLineup }),
    pairHome,
    forgetHome,
    refreshHome,
    defaults: D,
  };
})();
