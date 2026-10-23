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

  const BROADCAST_HINT = /\b(full broadcast|broadcasts?|with (ads|commercials)|off[- ]air|vhs recording|recorded (on|from))\b/i;

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

  function parseSearch(json) {
    const r = json.response || { numFound: 0, docs: [] };
    return {
      total: r.numFound,
      items: r.docs.map((d) => ({
        source: 'archive',
        id: d.identifier,
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
    return { ...parseSearch(await getJson(url)), page, rows };
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

  return { SCOPES, CATEGORIES, buildQuery, parseSearch, parseItem, downloadUrl, searchUrl, search, item, allows };
});
