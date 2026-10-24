'use strict';
// Viewing profiles (Kids / Family / Late Night) from channels.json "settings.profiles".
// A profile picks channels by number or range ("20-29", "*"), can cap ratings (except for its
// "always" channels), and can be locked behind the PIN. "settings.profileSchedule" switches profiles at set times.

const Profiles = (() => {
  const RATINGS = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const rank = (r) => RATINGS.indexOf(String(r || '').toUpperCase());

  function matches(list, n) {
    if (list == null) return true;
    return [].concat(list).some((x) => {
      const s = String(x).trim();
      if (s === '*') return true;
      const m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
      return m ? n >= Number(m[1]) && n <= Number(m[2]) : Number(s) === n;
    });
  }

  // "always": channels this profile shows whatever their rating (e.g. wrestling and sports).
  function allowsChannel(p, ch) {
    if (!p) return true;
    if (p.always && matches(p.always, ch.number)) return true;
    if (!matches(p.channels, ch.number)) return false;
    if (p.maxRating && ch.rating && rank(ch.rating) > rank(p.maxRating)) return false;
    return true;
  }

  // Unrated files are allowed unless the profile says otherwise ("allowUnrated": false).
  function allowsFile(p, f, ch) {
    if (!p || !p.maxRating) return true;
    if (ch && p.always && matches(p.always, ch.number)) return true;
    if (!f.rating || rank(f.rating) < 0) return p.allowUnrated !== false;
    return rank(f.rating) <= rank(p.maxRating);
  }

  // The profile the schedule says should be on at `at`, or null if there's no schedule.
  // Entries: { "at": "07:00", "profile": "kids", "days": ["mon", ...] (optional) }
  function scheduled(settings, at = Date.now()) {
    const list = (settings && settings.profileSchedule) || [];
    let best = null;
    const now = new Date(at);
    for (let back = 0; back <= 7 && !best; back++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      for (const e of list) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(e.at || '');
        if (!m) continue;
        if (e.days && e.days.length && !e.days.map((d) => String(d).slice(0, 3).toLowerCase()).includes(DAYS[day.getDay()])) continue;
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[1]), Number(m[2])).getTime();
        if (t <= at && (!best || t > best.t)) best = { t, profile: e.profile };
      }
    }
    return best ? best.profile : null;
  }

  return { RATINGS, matches, allowsChannel, allowsFile, scheduled };
})();
