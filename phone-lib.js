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

  async function load() {
    channels = (await DB.get('channels')) || D.channels.map((c) => ({ ...c }));
    settings = { ...D.settings, ...((await DB.get('settings')) || {}) };
    entries = await DB.entries();
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
    return [...D.live.map((c) => ({ ...c })), ...locals];
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
    defaults: D,
  };
})();
