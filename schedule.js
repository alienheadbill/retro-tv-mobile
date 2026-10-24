'use strict';
// Wall-clock scheduling for channels built from your own files. Every channel runs a fixed
// loop that started on Jan 1 2000, so tuning in drops you mid-show like real TV, and the
// guide can show what's on later.
//
// Channels can also have time blocks (channel.json "blocks"), e.g. Toonami on weekday
// afternoons. A block plays its own rotation while it's on; the rest of the day plays the
// channel's regular rotation. Complete broadcasts (recordings that already contain their
// commercials) never get extra breaks and play in air-date order.
//
// Order "grouped" keeps things that belong together back to back: every video can carry a
// group (a Finals series, a wrestling event), its part in it (game 3, match 5) and when it
// happened. Parts play in order; groups play shuffled, in date order ("groupOrder": "date"),
// or as listed ("groupOrder": "listed").

const Schedule = (() => {
  const EPOCH = new Date(2000, 0, 1).getTime();
  const DAY = 86400000;
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rand) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function grouped(eps, how, rand) {
    const groups = new Map();
    eps.forEach((e, i) => {
      const k = e.group != null ? 'g:' + e.group : 'u:' + e.url;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ e, i });
    });
    const partOf = (x) => (Number.isFinite(x.e.part) ? x.e.part : x.i);
    let list = [...groups.values()].map((g) => g.sort((a, b) => partOf(a) - partOf(b) || a.i - b.i).map((x) => x.e));
    if (how === 'date') {
      const when = (g) => g.map((e) => e.when).filter(Boolean).sort()[0] || null;
      const dated = list.filter(when).sort((a, b) => when(a).localeCompare(when(b)));
      const undated = shuffle(list.filter((g) => !when(g)), rand);
      // Spread the undated ones evenly through the dated run.
      list = [];
      let u = 0;
      dated.forEach((g, i) => {
        list.push(g);
        while (u < undated.length && (u + 1) / (undated.length + 1) <= (i + 1) / dated.length) list.push(undated[u++]);
      });
      while (u < undated.length) list.push(undated[u++]);
    } else if (how !== 'listed') {
      list = shuffle(list, rand);
    }
    return list.flat();
  }

  const byAirDate = (a, b) =>
    (a.airDate || '').localeCompare(b.airDate || '') || a.url.localeCompare(b.url, undefined, { numeric: true });

  // A segment is one show plus the break after it: bumper, then commercials.
  function cycle(episodes, opts) {
    const { durationOf, breaks, order, groupOrder, seed, bumpers, commercials } = opts;
    const playable = (f) => durationOf(f) > 0;
    const rand = rng(seed);
    let eps = episodes.filter(playable);
    if (order === 'broadcast') eps = eps.slice().sort(byAirDate);
    else if (order === 'grouped') eps = grouped(eps, groupOrder, rand);
    else if (order !== 'sequential') eps = shuffle(eps, rand);
    const bums = bumpers.filter(playable);
    const coms = commercials.filter(playable);
    const pick = (list) => list[Math.floor(rand() * list.length)];

    const segments = [];
    let t = 0;
    for (const ep of eps) {
      const items = [{ file: ep, kind: 'show', dur: durationOf(ep) }];
      if (!ep.broadcast) {
        for (let i = 0; bums.length && i < breaks.bumpers; i++) {
          const f = pick(bums);
          items.push({ file: f, kind: 'bumper', dur: durationOf(f) });
        }
        for (let i = 0; coms.length && i < breaks.commercials; i++) {
          const f = pick(coms);
          items.push({ file: f, kind: 'commercial', dur: durationOf(f) });
        }
      }
      const len = items.reduce((s, it) => s + it.dur, 0);
      segments.push({ show: ep.show, title: ep.title, broadcast: !!ep.broadcast, start: t, len, items });
      t += len;
    }
    return { segments, total: t };
  }

  const minutes = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };

  // lookup(number) -> another channel, for blocks that borrow a channel's shows.
  function build(ch, durationOf, breaks, lookup = () => null) {
    const order = ch.mode === 'broadcast' ? 'broadcast' : ch.order;
    const common = { durationOf, breaks, groupOrder: ch.groupOrder, bumpers: ch.bumpers, commercials: ch.commercials };
    const base = cycle(ch.episodes, { ...common, order, seed: ch.number * 7919 + 17 });
    const blocks = [];
    (ch.blocks || []).forEach((b, i) => {
      const start = minutes(b.start);
      const end = minutes(b.end);
      if (start == null || end == null || start === end) return;
      const from = b.channel != null ? lookup(Number(b.channel)) : ch;
      if (!from) return;
      const wanted = (b.shows || []).map((s) => s.toLowerCase());
      const eps = from.episodes.filter((e) => !wanted.length || wanted.includes((e.show || '').toLowerCase()));
      const cyc = cycle(eps, {
        ...common,
        breaks: { ...breaks, ...(b.breaks || {}) },
        order: b.order || order,
        seed: ch.number * 7919 + 101 * (i + 1),
      });
      if (!cyc.total) return;
      const days = (b.days || []).map((d) => DAYS.indexOf(String(d).slice(0, 3).toLowerCase())).filter((d) => d >= 0);
      blocks.push({ name: b.name || 'Block', start, end, days, ...cyc });
    });
    return { segments: base.segments, total: base.total, base, blocks };
  }

  // Occurrences of a block around time `at` (yesterday through tomorrow), as [startMs, endMs).
  function occurrences(block, at) {
    const out = [];
    const d0 = new Date(at);
    for (let off = -1; off <= 2; off++) {
      const day = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + off);
      if (block.days.length && !block.days.includes(day.getDay())) continue;
      const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, block.start).getTime();
      const len = ((block.end - block.start + 1440) % 1440) * 60000;
      out.push([s, s + len]);
    }
    return out;
  }

  // Which rotation is on at `at`, and until when.
  function context(sched, at) {
    let nextStart = Infinity;
    for (const b of sched.blocks || []) {
      for (const [s, e] of occurrences(b, at)) {
        if (at >= s && at < e) {
          const occ = Math.floor((s - EPOCH) / DAY);
          return { cycle: b, name: b.name, start: s, end: e, pos: (occ * (e - s)) / 1000 + (at - s) / 1000 };
        }
        if (s > at) nextStart = Math.min(nextStart, s);
      }
    }
    return { cycle: sched.base || sched, name: null, start: -Infinity, end: nextStart, pos: (at - EPOCH) / 1000 };
  }

  function locateIn(ctx, at) {
    const cyc = ctx.cycle;
    if (!cyc.total) return null;
    const pos = ((ctx.pos % cyc.total) + cyc.total) % cyc.total;
    const segIndex = cyc.segments.findIndex((s) => pos < s.start + s.len);
    const seg = cyc.segments[segIndex];
    const segStartMs = at - (pos - seg.start) * 1000;
    let off = pos - seg.start;
    for (const item of seg.items) {
      if (off < item.dur) return { seg, segIndex, item, offset: off, segStartMs, cyc };
      off -= item.dur;
    }
    const last = seg.items[seg.items.length - 1];
    return { seg, segIndex, item: last, offset: last.dur, segStartMs, cyc };
  }

  // What's playing at `at`: { item, offset (s), seg, segStartMs, block, contextEnd (ms) } or null.
  function locate(sched, at) {
    let ctx = context(sched, at);
    let loc = locateIn(ctx, at);
    if (!loc && ctx.name) {
      ctx = { ...context({ base: sched.base || sched }, at), end: ctx.end };
      loc = locateIn(ctx, at);
    }
    return loc && { ...loc, block: ctx.name, contextEnd: ctx.end };
  }

  // Guide listings between two times (ms): [{show, title, start, end, block, broadcast}].
  function listings(sched, from, to) {
    const out = [];
    let t = from;
    while (t < to && out.length < 300) {
      const ctx = context(sched, t);
      const loc = locateIn(ctx, t) || (ctx.name ? locateIn(context({ base: sched.base || sched }, t), t) : null);
      const end = Math.min(ctx.end, to);
      if (!loc) {
        t = end === Infinity ? to : end;
        continue;
      }
      let i = loc.segIndex;
      let segStart = loc.segStartMs;
      while (segStart < end && out.length < 300) {
        const seg = loc.cyc.segments[i];
        const segEnd = segStart + seg.len * 1000;
        out.push({
          show: seg.show,
          title: seg.title,
          broadcast: seg.broadcast,
          block: ctx.name,
          start: Math.max(segStart, ctx.start),
          end: Math.min(segEnd, ctx.end),
        });
        segStart = segEnd;
        i = (i + 1) % loc.cyc.segments.length;
      }
      t = end;
    }
    return out;
  }

  return { build, locate, listings, minutes };
})();
