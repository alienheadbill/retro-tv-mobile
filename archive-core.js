// Internet Archive parsing and query building, shared by the desktop adapter (require) and the
// phone app (plain <script>, exposes window.ArchiveCore). No network code lives here: callers
// pass in their own getJson(url).
// APIs: advancedsearch.php (search), /metadata/<id> (files with md5/size/length/height),
// /download/<id>/<file> (302 to a storage node, supports Range requests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../meta'));
  else root.ArchiveCore = factory(root.RetroMeta);
})(typeof self !== 'undefined' ? self : this, function (Meta) {
  const { qualityScore, IMPORT_EXTS, VIDEO_EXTS, ext: extOf } = Meta;

  const SCOPES = {
    vhsvault: { label: 'VHS Vault (off-air TV & tapes)', q: 'collection:(vhsvault)' },
    vhskids: { label: "VHS Vault: Kids' Shows", q: 'collection:(vhskids)' },
    video: { label: 'All Internet Archive video', q: 'mediatype:(movies)' },
    classic_tv: { label: 'Classic TV', q: 'collection:(classic_tv)' },
    prelinger: { label: 'Prelinger Archives', q: 'collection:(prelinger)' },
  };

  const CATEGORIES = {
    broadcast: '("full broadcast" OR broadcast OR "with ads" OR "with commercials" OR "off-air" OR "off air")',
    commercials: '(commercial OR commercials OR ads OR advertisements)',
    bumpers: '(bumper OR bumpers OR bumps OR idents OR promos OR "station id")',
    episodes: '(episode OR episodes OR season OR "complete series")',
  };

  // WOC: collectors' shorthand for "with original commercials".
  const BROADCAST_HINT = /\b(full broadcast|broadcasts?|with (original )?(ads|commercials)|woc|off[- ]air|vhs recording|recorded (on|from)|tape ?#?\d+)\b/i;

  // Formats Chromium plays as-is, by IA format name or extension. The phone passes its own list.
  const PLAYABLE_FORMAT = /^(h\.264( ia| hd)?|mpeg4|512kb mpeg4|ogg video|webm|matroska|quicktime)$/i;
  const PLAYABLE_EXT = new Set(VIDEO_EXTS);
  const IMPORTABLE = new Set(IMPORT_EXTS);

  const quote = (s) => '"' + String(s).replace(/["\\]/g, ' ').trim() + '"';

  function buildQuery({ text = '', scope = 'vhsvault', network = '', yearFrom, yearTo, category = '' } = {}) {
    const parts = [];
    const t = String(text).trim();
    if (t) parts.push(/[():"]/.test(t) ? t : t.split(/\s+/).map(quote).join(' AND '));
    if (SCOPES[scope]) parts.push(SCOPES[scope].q);
    if (network) parts.push(quote(network));
    if (yearFrom || yearTo) parts.push(`year:[${Number(yearFrom) || 1900} TO ${Number(yearTo) || 2099}]`);
    if (CATEGORIES[category]) parts.push(CATEGORIES[category]);
    if (!parts.length) parts.push(SCOPES.vhsvault.q);
    // Collections contain sub-collections too; only items with video are useful here.
    if (!/mediatype/.test(parts.join(' '))) parts.push('mediatype:(movies)');
    return parts.join(' AND ');
  }

  function stripHtml(s) {
    return String(Array.isArray(s) ? s.join('\n') : s || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  const first = (v) => (Array.isArray(v) ? v[0] : v);

  // What a search result most likely is, from its title (and description, for broadcasts) and
  // size. Only a hint for sorting and labels: the item's own files are what to trust.
  const KINDS = [
    ['commercials', /\b(commercials?|ads|adverts?|advertisements?)\b/i],
    ['bumpers', /\b(bump(er)?s|idents?|station ids?|network ids?|promos?)\b/i],
    ['episode', /\bS\d{1,2} ?E\d{1,3}\b|\b\d{1,2}x\d{2}\b|\bepisodes?\b|\bseasons?\b|\bep\.? ?\d+\b|\b(complete|full) series\b/i],
    ['clip', /\b(clips?|trailers?|teasers?|previews?|excerpts?|scenes?|intros?|openings?|theme songs?|credits)\b/i],
  ];
  function kindOf(title, description, size) {
    if (BROADCAST_HINT.test(title) || BROADCAST_HINT.test(description)) return 'broadcast';
    const k = KINDS.find(([, re]) => re.test(title));
    if (k) return k[0];
    // Under 20 MB is a few minutes of video at most.
    return size && size < 20e6 ? 'clip' : 'video';
  }

  // What each category is after, best first. Videos of unknown kind come next, clips last.
  const WANT = { broadcast: ['broadcast'], episodes: ['episode', 'broadcast'], commercials: ['commercials'], bumpers: ['bumpers'] };

  // One page of results, put in a useful order: near-identical uploads (same title and year) are
  // folded into the first, and for a category the kinds it's after come first, clips last, each
  // group keeping the archive's own order.
  function arrange(items, category) {
    const seen = new Map();
    const kept = [];
    for (const it of items) {
      const k = `${String(it.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${it.year || ''}`;
      if (seen.has(k)) {
        seen.get(k).similar = (seen.get(k).similar || 0) + 1;
        continue;
      }
      seen.set(k, it);
      kept.push(it);
    }
    const want = WANT[category];
    if (!want) return kept;
    const score = (it) => (want.includes(it.kind) ? 3 - want.indexOf(it.kind) / want.length : it.kind === 'video' ? 1 : it.kind === 'clip' ? -1 : 0);
    return kept.map((it, i) => ({ it, i, s: score(it) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.it);
  }

  // The lengths of an item's videos (one file per version group, so archive copies of the same
  // video don't count twice): how many, the longest and the total, in seconds.
  function lengths(item) {
    const videos = item.files.filter((f) => f.recommended && f.length);
    return {
      videos: videos.length,
      longest: videos.reduce((m, f) => Math.max(m, f.length), 0) || null,
      total: videos.reduce((s, f) => s + f.length, 0) || null,
    };
  }

  // A result's kind once its real lengths are known: nothing over 5 minutes is a clip, and an
  // unlabelled video or "clip" of an hour and a half or more is a recording of TV as it aired.
  // Ads and bumpers keep their kind (compilations run long).
  function kindByLength(kind, len) {
    if (!len || !len.longest || kind === 'commercials' || kind === 'bumpers') return kind;
    if (len.longest < 300) return 'clip';
    if (len.longest >= 5400 && (kind === 'video' || kind === 'clip')) return 'broadcast';
    if (kind === 'clip') return 'video';
    return kind;
  }

  function parseSearch(json) {
    const r = json.response || { numFound: 0, docs: [] };
    return {
      total: r.numFound,
      items: r.docs.map((d) => ({
        source: 'archive',
        id: d.identifier,
        kind: kindOf(stripHtml(first(d.title)), stripHtml(first(d.description)), d.item_size || null),
        title: stripHtml(first(d.title)) || d.identifier,
        date: first(d.date) || null,
        year: Number(first(d.year)) || null,
        downloads: d.downloads || 0,
        size: d.item_size || null,
        description: stripHtml(first(d.description)).slice(0, 400),
        collections: [].concat(d.collection || []),
        url: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
        thumb: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
        broadcastHint: BROADCAST_HINT.test(`${first(d.title)} ${first(d.description)}`),
      })),
    };
  }

  function downloadUrl(id, name) {
    return `https://archive.org/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
  }

  // opts.playable(file) overrides what counts as playable (the phone plays MP4 only).
  function parseItem(json, opts = {}) {
    const m = json.metadata || {};
    const id = m.identifier;
    const title = stripHtml(first(m.title)) || id;
    const description = stripHtml(m.description);
    const itemBroadcast = BROADCAST_HINT.test(`${title} ${description}`);
    const playableExt = opts.playableExts ? new Set(opts.playableExts) : PLAYABLE_EXT;

    const files = (json.files || [])
      .filter((f) => IMPORTABLE.has(extOf(f.name)) && f.format !== 'Thumbnail')
      .map((f) => {
        const ext = extOf(f.name);
        const length = Number(f.length) || null;
        const size = Number(f.size) || null;
        const height = Number(f.height) || null;
        const original = f.source === 'original';
        const bitrate = size && length ? Math.round((size * 8) / length) : null;
        const isSub = ext === '.srt' || ext === '.vtt';
        return {
          name: f.name,
          format: f.format || ext.slice(1).toUpperCase(),
          original,
          // Derivatives name the original they were made from; originals group with themselves.
          group: original ? f.name : f.original || f.name,
          size,
          md5: f.md5 || null,
          sha1: f.sha1 || null,
          length,
          width: Number(f.width) || null,
          height,
          bitrate,
          subtitle: isSub,
          playable: !isSub && playableExt.has(ext) && (opts.playableExts || PLAYABLE_FORMAT.test(f.format || '') || PLAYABLE_EXT.has(ext)) && ext !== '.vob',
          needsConversion: !isSub && !playableExt.has(ext),
          broadcastHint: itemBroadcast || BROADCAST_HINT.test(f.name) || (length || 0) > 3 * 3600,
          url: downloadUrl(id, f.name),
          score: qualityScore({ original, height, bitrate }),
        };
      });

    // In each group, recommend the best file that plays as-is; if none can, the best overall.
    const groups = new Map();
    for (const f of files) {
      if (f.subtitle) continue;
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push(f);
    }
    for (const list of groups.values()) {
      const playable = list.filter((f) => f.playable);
      const pick = (playable.length ? playable : list).sort((a, b) => b.score - a.score)[0];
      pick.recommended = true;
    }

    return {
      source: 'archive',
      id,
      title,
      description: description.slice(0, 4000),
      date: first(m.date) || null,
      year: Number(first(m.year)) || (first(m.date) ? Number(String(first(m.date)).slice(0, 4)) || null : null),
      collections: [].concat(m.collection || []),
      subjects: [].concat(m.subject || []).slice(0, 20),
      license: m.licenseurl || null,
      url: `https://archive.org/details/${encodeURIComponent(id)}`,
      broadcastHint: itemBroadcast,
      files: files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    };
  }

  function searchUrl(opts = {}) {
    const rows = Math.min(Number(opts.rows) || 30, 100);
    const page = Math.max(Number(opts.page) || 1, 1);
    const params = new URLSearchParams({ q: buildQuery(opts), rows: String(rows), page: String(page), output: 'json' });
    for (const f of ['identifier', 'title', 'date', 'year', 'downloads', 'item_size', 'description', 'collection']) params.append('fl[]', f);
    params.append('sort[]', opts.sort === 'date' ? 'date asc' : opts.sort === 'new' ? 'publicdate desc' : 'downloads desc');
    return { url: `https://archive.org/advancedsearch.php?${params}`, page, rows };
  }

  async function search(opts, getJson) {
    const { url, page, rows } = searchUrl(opts);
    const r = parseSearch(await getJson(url));
    const items = arrange(r.items, opts.category);
    return { ...r, items, folded: r.items.length - items.length, page, rows };
  }

  async function item(id, getJson, parseOpts) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) throw new Error('Not an Internet Archive identifier: ' + id);
    const json = await getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    if (!json || !json.metadata) throw new Error('No such item: ' + id);
    return parseItem(json, parseOpts);
  }

  // Downloads may only come from archive.org and its storage nodes.
  function allows(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && (u.hostname === 'archive.org' || u.hostname.endsWith('.archive.org'));
    } catch {
      return false;
    }
  }

  return { SCOPES, CATEGORIES, buildQuery, parseSearch, arrange, kindOf, lengths, kindByLength, parseItem, downloadUrl, searchUrl, search, item, allows };
});
