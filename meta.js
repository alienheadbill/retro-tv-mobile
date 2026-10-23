// What a file's name and folder say about it. Shared by the desktop app (require) and the
// phone app (plain <script>, exposes window.RetroMeta).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetroMeta = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NETWORKS = [
    [/\badult ?swim\b|\[as\]/i, 'Adult Swim'],
    [/\btoonami\b/i, 'Toonami'],
    [/\bcartoon ?network\b|\bcn\b|cartoon cartoon/i, 'Cartoon Network'],
    [/\bnick ?jr\b/i, 'Nick Jr.'],
    [/\bnickelodeon\b|\bnick\b|\bnicktoons\b|\bsnick\b/i, 'Nickelodeon'],
    [/\bnoggin\b/i, 'Noggin'],
    [/one saturday morning/i, "Disney's One Saturday Morning"],
    [/\bdisney\b|\btoon disney\b/i, 'Disney Channel'],
    [/\bfox ?kids\b/i, 'Fox Kids'],
    [/\bkids'? ?wb\b/i, "Kids' WB"],
    [/\b4kids\b/i, '4Kids TV'],
    [/\bpbs\b|\bwqed\b/i, 'PBS Kids'],
    [/\bg4\b|\btechtv\b|x-?play|attack of the show/i, 'G4'],
    [/\bmtv\b/i, 'MTV'],
  ];

  // Words in a title that usually mean "this is a recording of TV as it aired".
  const BROADCAST_HINT = /\b(full broadcast|broadcast|with (ads|commercials)|off[- ]air|vhs recording|tape \d+|marathon|block)\b/i;

  // What a file's folder says about it: its role on air, and its show if it sits in a show folder.
  function placement(parts) {
    const out = { role: 'show' };
    if (parts[0] === 'bumpers' || parts.includes('_bumpers')) out.role = 'bumper';
    else if (parts[0] === 'commercials' || parts.includes('_commercials')) out.role = 'commercial';
    else if (parts[0] === 'inbox') out.role = 'unassigned';
    if (parts[0] === 'channels' && parts.length > 3 && !parts[2].startsWith('_')) out.show = parts[2];
    return out;
  }

  function guessMeta(rel) {
    const parts = rel.split(/[\\/]/);
    const file = parts[parts.length - 1];
    const name = file.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
    const meta = { title: name, ...placement(parts) };

    const se = name.match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i) || name.match(/\b(\d{1,2})x(\d{2})\b/);
    if (se) {
      meta.season = Number(se[1]);
      meta.episode = Number(se[2]);
    }
    const raw = file.replace(/\.[^.]+$/, '');
    const date = raw.match(/\b(19[89]\d|20[0-2]\d)[-._ ](\d{2})[-._ ](\d{2})\b/) || raw.match(/\b(\d{2})[-.](\d{2})[-.](\d{2})\b/);
    if (date && date[1].length === 4) {
      meta.airDate = `${date[1]}-${date[2]}-${date[3]}`;
      meta.year = Number(date[1]);
    } else if (date) {
      // 12.26.04 style (month.day.year)
      const yy = Number(date[3]);
      meta.year = yy < 30 ? 2000 + yy : 1900 + yy;
      meta.airDate = `${meta.year}-${date[1]}-${date[2]}`;
    } else {
      const y = name.match(/\b(19[89]\d|20[01]\d)\b/);
      if (y) meta.year = Number(y[1]);
    }
    const hay = rel.replace(/[\\/]/g, ' ');
    const net = NETWORKS.find(([re]) => re.test(hay));
    if (net) meta.network = net[1];
    if (BROADCAST_HINT.test(hay)) meta.broadcast = true;
    return meta;
  }

  const VIDEO_EXTS = ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv'];
  // Files we'll download or import: playable video, formats FFmpeg can convert, subtitles.
  const IMPORT_EXTS = [...VIDEO_EXTS, '.mpg', '.mpeg', '.vob', '.avi', '.wmv', '.flv', '.ts', '.srt', '.vtt'];
  const ext = (name) => (/\.[^./\\]+$/.exec(String(name)) || [''])[0].toLowerCase();

  // Higher is better: originals over re-encodes, then resolution, then bitrate.
  function qualityScore({ original = false, height = 0, bitrate = 0 } = {}) {
    return (original ? 1e9 : 0) + (height || 0) * 1e5 + Math.min(bitrate || 0, 9.9e7) / 1000;
  }

  return { NETWORKS, BROADCAST_HINT, placement, guessMeta, VIDEO_EXTS, IMPORT_EXTS, ext, qualityScore };
});
