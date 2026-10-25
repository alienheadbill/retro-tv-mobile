'use strict';
// Playback health and recovery, shared by the PC TV, the phone TV and the Library.
//
// Every source (a file, a YouTube video, a stream) gets a record of how it has behaved: last
// success, last failure, failures in a row, stalls, load time. From that it's healthy, degraded,
// unavailable or unverified (never tried, or a player that can't tell us). A failed source rests
// before it's tried again, doubling each time (1 minute, 2, 4, ... up to 6 hours); one that's
// gone for good (removed, private) rests the full 6 hours straight away.
//
// When something fails, the TV keeps the schedule as it is and recovers in this order: try the
// same source again, then another source of the same program, then a stand-in for the rest of
// that time slot (same show first, then the channel's other programs), then a standby card
// until the next slot. Stand-ins are chosen the same way for the same slot, so the PC and the
// phone agree, and every stand-in is recorded as what actually aired.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Health = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STATUS = { HEALTHY: 'healthy', DEGRADED: 'degraded', UNAVAILABLE: 'unavailable', UNVERIFIED: 'unverified' };
  const MINUTE = 60000;

  // opts: { now, base (first rest, ms), max (longest rest, ms), unavailableAfter (failures),
  //         records (saved state, from all()) }
  function monitor(opts = {}) {
    const now = opts.now || (() => Date.now());
    const base = opts.base || MINUTE;
    const max = opts.max || 6 * 60 * MINUTE;
    const unavailableAfter = opts.unavailableAfter || 3;
    const records = new Map(Object.entries(opts.records || {}));
    let changed = false;

    const rec = (key) => {
      let r = records.get(key);
      if (!r) records.set(key, (r = { failures: 0, stalls: 0 }));
      changed = true;
      return r;
    };

    return {
      // It played (loadMs: how long it took to start).
      ok(key, info = {}) {
        const r = rec(key);
        r.lastOk = now();
        r.failures = 0;
        r.retryAt = 0;
        r.permanent = false;
        if (info.loadMs != null) r.loadMs = Math.round(info.loadMs);
        if (info.kind) r.kind = info.kind;
      },
      // It didn't. permanent: the source itself is gone (removed, private, not found).
      fail(key, info = {}) {
        const r = rec(key);
        r.failures = (r.failures || 0) + 1;
        r.lastFail = now();
        r.lastError = String(info.reason || 'error').slice(0, 200);
        r.permanent = !!info.permanent;
        r.retryAt = now() + (r.permanent ? max : Math.min(max, base * 2 ** (r.failures - 1)));
        if (info.kind) r.kind = info.kind;
      },
      // It stopped to buffer for too long (counts against it, but isn't a failure by itself).
      stall(key) {
        const r = rec(key);
        r.stalls = (r.stalls || 0) + 1;
        r.lastStall = now();
      },
      // Worth trying now? (Never tried, or its rest is over.)
      usable(key) {
        const r = records.get(key);
        return !r || !r.retryAt || now() >= r.retryAt;
      },
      status(key) {
        return classify(records.get(key), unavailableAfter, now());
      },
      get: (key) => records.get(key) || null,
      // A channel from its sources: unavailable only if every source is; degraded if any is shaky.
      channelStatus(keys) {
        const all = [...keys].map((k) => classify(records.get(k), unavailableAfter, now()));
        if (!all.length || all.every((s) => s === STATUS.UNVERIFIED)) return STATUS.UNVERIFIED;
        if (all.every((s) => s === STATUS.UNAVAILABLE || s === STATUS.UNVERIFIED) && all.includes(STATUS.UNAVAILABLE)) return STATUS.UNAVAILABLE;
        if (all.some((s) => s === STATUS.UNAVAILABLE || s === STATUS.DEGRADED)) return STATUS.DEGRADED;
        return STATUS.HEALTHY;
      },
      // Saved state: the most recently touched records (at most `limit`).
      all(limit = 800) {
        const list = [...records.entries()].sort((a, b) => last(b[1]) - last(a[1])).slice(0, limit);
        return Object.fromEntries(list);
      },
      // True once after anything changed (for saving).
      takeChanged() {
        const c = changed;
        changed = false;
        return c;
      },
    };
  }

  const last = (r) => Math.max(r.lastOk || 0, r.lastFail || 0, r.lastStall || 0);

  function classify(r, unavailableAfter, at) {
    if (!r || (!r.lastOk && !r.lastFail)) return STATUS.UNVERIFIED;
    if (r.failures > 0) return r.permanent || r.failures >= unavailableAfter ? STATUS.UNAVAILABLE : STATUS.DEGRADED;
    // Played fine, but kept stopping lately.
    if ((r.stalls || 0) >= 3 && r.lastStall && at - r.lastStall < 30 * MINUTE) return STATUS.DEGRADED;
    return STATUS.HEALTHY;
  }

  // What to do after a failure. attempt: { retries, permanent, alternates (count), alternatesTried }
  //   'retry'      the same source again (a hiccup, at most maxRetries times)
  //   'alternate'  another source of the same program
  //   'substitute' a stand-in for the rest of the slot
  function nextStep(attempt, maxRetries = 1) {
    const a = attempt || {};
    if (!a.permanent && (a.retries || 0) < maxRetries) return 'retry';
    if ((a.alternatesTried || 0) < (a.alternates || 0)) return 'alternate';
    return 'substitute';
  }

  // A small, stable hash (FNV-1a) for picking the same stand-in for the same slot everywhere.
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  const keyOf = (f) => f.key || f.url;

  // A stand-in for `failed` in the slot identified by `seed` (e.g. the slot's start time).
  // pool: the channel's programs of the same kind. Same show first, then anything else; never
  // the failed one, one already tried (exclude), or one resting (usable(key) false).
  function substitute(failed, pool, { usable = () => true, seed = '', exclude = [] } = {}) {
    const skip = new Set([keyOf(failed), ...exclude]);
    const ok = (pool || []).filter((f) => !skip.has(keyOf(f)) && usable(keyOf(f)) && (f.dur == null || f.dur > 0));
    if (!ok.length) return null;
    const rank = (f) => hash(`${seed}|${keyOf(f)}`);
    const show = (failed.show || '').toLowerCase();
    const same = show ? ok.filter((f) => (f.show || '').toLowerCase() === show) : [];
    const from = same.length ? same : ok;
    return from.slice().sort((a, b) => rank(a) - rank(b))[0];
  }

  return { STATUS, monitor, nextStep, substitute, classify, hash };
});
