'use strict';
// The phone's menu: My Shows, Add, Find (Internet Archive), Channels, Settings.

const Manage = (() => {
  const root = $('#manage');
  const sheet = $('#sheet');
  const sheetBox = $('#sheet .sheet-box');
  let tab = 'shows';

  // ---------- Helpers ----------

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') node[k] = !!v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
    return node;
  }

  const fmtBytes = (n) => {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  };
  const fmtDur = (s) => {
    if (!s) return '';
    s = Math.round(s);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    return hh ? `${hh}h ${mm}m` : `${mm}:${String(s % 60).padStart(2, '0')}`;
  };

  let toastTimer = 0;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = bad ? 'bad' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), bad ? 7000 : 3500);
  }

  function openSheet(...kids) {
    sheetBox.replaceChildren(...kids);
    sheet.hidden = false;
  }
  function closeSheet() {
    sheetBox.querySelectorAll('video').forEach((v) => v.pause());
    sheet.hidden = true;
    sheetBox.replaceChildren();
  }
  sheet.addEventListener('click', (e) => e.target === sheet && closeSheet());

  const RATINGS = ['', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
  const ratingSelect = (value) => h('select', { name: 'rating' }, RATINGS.map((r) => h('option', { value: r, selected: r === (value || '') }, r || 'Not rated')));
  const PLAYS_HERE = ['.mp4', '.m4v', '.mov'];
  const playsHere = (name) => PLAYS_HERE.includes(RetroMeta.ext(name));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  // Channel + role + show picker, reused by Add, Find and the editor.
  function destination(defaults = {}) {
    const chans = PhoneLib.channels();
    const where = h('select', null,
      h('option', { value: '' }, 'Not on a channel yet'),
      chans.map((c) => h('option', { value: String(c.number), selected: defaults.channel === c.number }, `${c.number}  ${c.name}`)));
    const role = h('select', null,
      h('option', { value: 'show', selected: !defaults.role || defaults.role === 'show' }, 'Show'),
      h('option', { value: 'bumper', selected: defaults.role === 'bumper' }, 'Bumper'),
      h('option', { value: 'commercial', selected: defaults.role === 'commercial' }, 'Commercial'));
    const show = h('input', { placeholder: 'Show name (optional)', value: defaults.show || '' });
    const sync = () => (show.disabled = role.value !== 'show');
    role.addEventListener('change', sync);
    sync();
    return {
      el: h('div', { class: 'grid' }, h('label', { class: 'wide' }, 'Channel', where), h('label', null, 'Plays as', role), h('label', null, 'Show', show)),
      value: () => ({
        channel: where.value ? Number(where.value) : null,
        role: role.value,
        show: role.value === 'show' ? show.value.trim() : '',
      }),
    };
  }

  function measure(url) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      let done = false;
      const finish = (d) => {
        if (done) return;
        done = true;
        v.removeAttribute('src');
        v.load();
        resolve(d);
      };
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.onloadedmetadata = () => finish(Number.isFinite(v.duration) ? v.duration : 0);
      v.onerror = () => finish(0);
      setTimeout(() => finish(0), 20000);
      v.src = url;
    });
  }

  // ---------- Open / close ----------

  function open() {
    TV.pause();
    root.hidden = false;
    render();
  }
  function close() {
    closeSheet();
    root.hidden = true;
    TV.resume();
  }
  $('#manage-close').addEventListener('click', close);
  root.querySelectorAll('header nav button').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      root.querySelectorAll('header nav button').forEach((x) => x.classList.toggle('on', x === b));
      root.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + tab));
      render();
    })
  );

  function render() {
    ({ shows: renderShows, add: renderAdd, find: renderFind, channels: renderChannels, settings: renderSettings })[tab]();
  }

  // ---------- My Shows ----------

  function entryLine(e) {
    const bits = [e.show, e.network, e.year, fmtDur(e.duration), e.kind === 'stream' ? null : fmtBytes(e.size)].filter(Boolean).join(' · ');
    return h('div', { class: 'item tap', onclick: () => editEntry(e) },
      h('div', { class: 'grow' }, h('div', { class: 't' }, e.title || e.name), h('div', { class: 's' }, bits)),
      e.kind === 'stream' ? h('span', { class: 'badge' }, 'streams') : null,
      e.broadcast ? h('span', { class: 'badge gold' }, 'broadcast') : null,
      e.rating ? h('span', { class: 'badge' }, e.rating) : null,
      !e.duration ? h('span', { class: 'badge warn' }, "won't play") : null);
  }

  function renderShows() {
    const pane = $('#pane-shows');
    const entries = PhoneLib.entries().slice().sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true }));
    if (!entries.length) {
      return pane.replaceChildren(
        h('h3', null, 'Nothing on this device yet'),
        h('p', null, 'Add videos from the Files app in the Add tab, or find shows in the Find tab.'),
        h('button', { class: 'btn primary', onclick: () => root.querySelector('[data-tab=add]').click() }, 'Add videos'));
    }
    const groups = [];
    for (const c of PhoneLib.channels()) {
      const list = entries.filter((e) => e.channel === c.number);
      if (list.length) groups.push([`${c.number}  ${c.name}`, list]);
    }
    const loose = (role) => entries.filter((e) => e.channel == null && e.role === role);
    groups.push(['Bumpers for every channel', loose('bumper')], ['Commercials for every channel', loose('commercial')], ['Not on a channel yet', loose('show')]);
    pane.replaceChildren(...groups.filter(([, l]) => l.length).flatMap(([title, list]) => [h('h3', null, `${title} (${list.length})`), h('div', { class: 'list' }, list.map(entryLine))]));
  }

  async function editEntry(e) {
    const dest = destination(e);
    const title = h('input', { value: e.title || '' });
    const network = h('input', { value: e.network || '' });
    const year = h('input', { type: 'number', value: e.year || '' });
    const airDate = h('input', { type: 'date', value: e.airDate || '' });
    const rating = ratingSelect(e.rating);
    const broadcast = h('input', { type: 'checkbox', checked: !!e.broadcast });
    const video = h('video', { controls: true, playsinline: true, preload: 'metadata' });
    let url = e.kind === 'stream' ? e.url : null;
    if (!url) {
      const blob = await DB.blob(e.id);
      if (blob) url = URL.createObjectURL(blob);
    }
    if (url) video.src = url;
    openSheet(
      h('div', { class: 'row' }, h('b', { style: 'flex:1' }, e.title || e.name), h('button', { class: 'btn', onclick: closeSheet }, 'Close')),
      url ? video : h('p', { class: 'muted' }, 'The video file is missing from this device.'),
      h('label', null, 'Title', title),
      dest.el,
      h('div', { class: 'grid' }, h('label', null, 'Network', network), h('label', null, 'Year', year), h('label', null, 'Air date', airDate), h('label', null, 'Rating', rating)),
      h('label', { class: 'check' }, broadcast, 'Complete broadcast (has its own commercials)'),
      h('p', { class: 'muted' }, [e.name, e.kind === 'stream' ? 'Streams from the Internet Archive (needs internet)' : fmtBytes(e.size), fmtDur(e.duration)].filter(Boolean).join(' · ')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          const d = dest.value();
          await PhoneLib.putEntry({
            ...e, ...d,
            title: title.value.trim() || e.name,
            network: network.value.trim() || null,
            year: year.value ? Number(year.value) : null,
            airDate: airDate.value || null,
            rating: rating.value || null,
            broadcast: broadcast.checked,
          });
          if (url && e.kind !== 'stream') URL.revokeObjectURL(url);
          closeSheet();
          toast('Saved');
          renderShows();
        } }, 'Save'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm(`Remove "${e.title || e.name}" from this device?`)) return;
          await PhoneLib.removeEntry(e.id);
          closeSheet();
          toast('Removed');
          renderShows();
        } }, e.kind === 'stream' ? 'Remove' : 'Delete from device'))
    );
  }

  // ---------- Add (import from Files) ----------

  async function renderAdd() {
    const pane = $('#pane-add');
    const setup = await DB.get('setup');
    const dest = destination();
    const useSetup = h('input', { type: 'checkbox', checked: !!setup });
    const log = h('div', { class: 'list' });
    const input = h('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/x-m4v,.mp4,.m4v,.mov', multiple: true, style: 'display:none' });
    input.addEventListener('change', () => importFiles([...input.files], dest.value(), useSetup.checked ? setup : null, log).finally(() => (input.value = '')));
    pane.replaceChildren(
      h('h3', null, 'Add videos from your phone'),
      h('p', { class: 'muted' }, 'Copy MP4 files to this device first (iCloud Drive, AirDrop or a cable into the Files app). Convert DVD, AVI and MKV files on the PC first: the Library window\'s "Make it play on the TV" turns them into MP4.'),
      h('div', { class: 'card' },
        dest.el,
        setup ? h('label', { class: 'check' }, useSetup, `Use the details from my PC setup when a file matches (${setup.entries.length} known files)`) : h('p', { class: 'muted' }, 'Tip: import your PC setup in Settings and matching files get their channel, show and details automatically.'),
        h('button', { class: 'btn primary', onclick: () => input.click() }, 'Choose videos...')),
      input,
      log
    );
  }

  let persisted = false;
  async function importFiles(files, dest, setup, log) {
    if (!files.length) return;
    if (!persisted && navigator.storage && navigator.storage.persist) persisted = await navigator.storage.persist().catch(() => false);
    let added = 0;
    for (const f of files) {
      const line = h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, f.name), h('div', { class: 's' }, 'Checking...')));
      log.prepend(line);
      const status = (text, cls) => {
        line.querySelector('.s').textContent = text;
        if (cls) line.append(h('span', { class: 'badge ' + cls }, cls === 'good' ? 'added' : 'skipped'));
      };
      if (!playsHere(f.name)) {
        status('Only MP4/M4V/MOV play on iPhone and iPad. Convert it on the PC first.', 'warn');
        continue;
      }
      const tmp = URL.createObjectURL(f);
      const duration = await measure(tmp);
      URL.revokeObjectURL(tmp);
      if (!duration) {
        status("This device can't play this file. Convert it on the PC (H.264/AAC MP4).", 'warn');
        continue;
      }
      const known = setup && (setup.entries.find((s) => s.name === f.name && s.size === f.size) || setup.entries.find((s) => s.name === f.name));
      const guess = RetroMeta.guessMeta(f.name);
      const entry = {
        id: uid(),
        kind: 'local',
        name: f.name,
        size: f.size,
        type: f.type,
        added: new Date().toISOString(),
        duration,
        title: guess.title,
        season: guess.season || null,
        episode: guess.episode || null,
        year: guess.year || null,
        airDate: guess.airDate || null,
        network: guess.network || null,
        broadcast: !!guess.broadcast,
        ...dest,
        ...(known ? Object.fromEntries(Object.entries(known).filter(([k, v]) => k !== 'name' && k !== 'size' && v != null && v !== '')) : {}),
      };
      try {
        await DB.putBlob(entry.id, f);
        await PhoneLib.putEntry(entry);
        added++;
        const ch = PhoneLib.channels().find((c) => c.number === entry.channel);
        const where = ch ? `${ch.number} ${ch.name}` : entry.role === 'show' ? 'Not on a channel yet' : 'Breaks on every channel';
        status(`${where}${entry.show ? ' · ' + entry.show : ''} · ${fmtDur(duration)}${known ? ' · details from PC setup' : ''}`, 'good');
      } catch (e) {
        status(e.message, 'warn');
        await DB.deleteEntry(entry.id).catch(() => {});
        if (/space/i.test(e.message)) break;
      }
    }
    toast(`${added} added`);
  }

  // ---------- Find (Internet Archive) ----------

  const getJson = async (url) => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Internet Archive answered ${res.status}`);
    return res.json();
  };
  let lastSearch = null;

  function renderFind() {
    const pane = $('#pane-find');
    if (pane.dataset.ready) return;
    pane.dataset.ready = '1';
    const text = h('input', { type: 'search', placeholder: 'Toonami, Rugrats, toy commercials...', enterkeyhint: 'search' });
    const scope = h('select', null, Object.entries(ArchiveCore.SCOPES).map(([id, s]) => h('option', { value: id }, s.label)));
    const category = h('select', null,
      h('option', { value: '' }, 'Anything'), h('option', { value: 'broadcast' }, 'Complete broadcasts'), h('option', { value: 'episodes' }, 'Episodes'),
      h('option', { value: 'commercials' }, 'Commercials'), h('option', { value: 'bumpers' }, 'Bumpers & promos'));
    const results = h('div', { class: 'list' });
    const info = h('p', { class: 'muted' }, 'Search the Internet Archive\'s off-air TV recordings. Videos you add here stream when you watch, so they need internet.');
    const more = h('button', { class: 'btn', hidden: true }, 'More results');
    const go = async (page = 1) => {
      if (!navigator.onLine) return toast('No internet connection', true);
      info.textContent = 'Searching...';
      try {
        const r = await ArchiveCore.search({ text: text.value, scope: scope.value, category: category.value, page, rows: 30 }, getJson);
        lastSearch = { page, total: r.total };
        if (page === 1) results.replaceChildren();
        info.textContent = r.total ? `${r.total.toLocaleString()} items` : 'Nothing found. Try fewer words.';
        for (const it of r.items) {
          results.append(h('div', { class: 'item tap', onclick: () => openItem(it.id) },
            h('img', { src: it.thumb, alt: '', loading: 'lazy' }),
            h('div', { class: 'grow' }, h('div', { class: 't' }, it.title), h('div', { class: 's' }, [it.year || (it.date || '').slice(0, 4), fmtBytes(it.size)].filter(Boolean).join(' · '))),
            it.broadcastHint ? h('span', { class: 'badge gold' }, 'with ads') : null));
        }
        more.hidden = page * r.rows >= r.total;
      } catch (e) {
        info.textContent = e.message;
      }
    };
    more.addEventListener('click', () => go(lastSearch.page + 1));
    const form = h('form', { class: 'card', onsubmit: (e) => (e.preventDefault(), text.blur(), go(1)) },
      text, h('div', { class: 'grid' }, h('label', null, 'Where', scope), h('label', null, 'Kind', category)),
      h('button', { class: 'btn primary', type: 'submit' }, 'Search'));
    pane.replaceChildren(form, info, results, h('div', { class: 'row', style: 'justify-content:center;margin-top:10px' }, more));
  }

  async function openItem(id) {
    openSheet(h('p', { class: 'muted' }, 'Loading files...'));
    let it;
    try {
      it = await ArchiveCore.item(id, getJson, { playableExts: PLAYS_HERE });
    } catch (e) {
      return openSheet(h('p', null, e.message), h('button', { class: 'btn', onclick: closeSheet }, 'Close'));
    }
    const have = new Set(PhoneLib.entries().filter((e) => e.kind === 'stream').map((e) => e.url));
    const videos = it.files.filter((f) => !f.subtitle);
    openSheet(
      h('div', { class: 'row' }, h('b', { style: 'flex:1' }, it.title), h('button', { class: 'btn', onclick: closeSheet }, 'Close')),
      h('p', { class: 'muted' }, [it.date, it.collections.slice(0, 2).join(', ')].filter(Boolean).join(' · ')),
      it.description ? h('p', { class: 'muted', style: 'max-height:90px;overflow:auto;white-space:pre-wrap' }, it.description) : null,
      h('div', { class: 'list' },
        videos.map((f) => h('div', { class: 'item' },
          h('div', { class: 'grow' },
            h('div', { class: 't' }, f.name),
            h('div', { class: 's' }, [f.height ? `${f.width}×${f.height}` : '', fmtDur(f.length), fmtBytes(f.size), f.original ? 'original' : 'archive copy'].filter(Boolean).join(' · '))),
          !f.playable ? h('span', { class: 'badge warn' }, 'not on phone')
            : have.has(f.url) ? h('span', { class: 'badge good' }, 'added')
            : h('div', { class: 'row' },
                h('button', { class: 'btn', onclick: () => watch(f) }, 'Watch'),
                h('button', { class: 'btn primary', onclick: () => addStream(it, f) }, 'Add'))))),
      h('p', { class: 'muted' }, 'To keep a video for offline use: tap Watch, then the share button in the player, then Save to Files. Then add it in the Add tab.')
    );
  }

  function watch(f) {
    const v = h('video', { controls: true, playsinline: true, autoplay: true, src: f.url });
    openSheet(h('div', { class: 'row' }, h('b', { style: 'flex:1' }, f.name), h('button', { class: 'btn', onclick: closeSheet }, 'Close')), v,
      h('a', { class: 'btn', href: f.url, target: '_blank', rel: 'noopener' }, 'Open in Safari (to save it)'));
  }

  function addStream(it, f) {
    const dest = destination();
    const broadcast = h('input', { type: 'checkbox', checked: f.broadcastHint });
    const rating = ratingSelect('');
    openSheet(
      h('b', null, 'Add to a channel'),
      h('p', { class: 'muted' }, `${f.name} · ${fmtDur(f.length)}. It streams from the Internet Archive when it's on, so it needs internet.`),
      dest.el,
      h('label', null, 'Rating', rating),
      h('label', { class: 'check' }, broadcast, 'Complete broadcast (has its own commercials)'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          let duration = f.length;
          if (!duration) duration = await measure(f.url);
          if (!duration) return toast("Couldn't read this video's length", true);
          const guess = RetroMeta.guessMeta(`${it.title}/${f.name}`);
          // DVD rips are named VTS_01_1 and so on; the item's title says what it actually is.
          const base = f.name.split('/').pop();
          const dvd = /^VTS_\d\d_(\d)/i.exec(base);
          const title = dvd ? `${it.title} (part ${dvd[1]})` : guess.title;
          await PhoneLib.putEntry({
            id: uid(), kind: 'stream', url: f.url, name: f.name, size: f.size, added: new Date().toISOString(), duration,
            title, year: guess.year || it.year || null, airDate: guess.airDate || null, network: guess.network || null,
            broadcast: broadcast.checked, rating: rating.value || null, source: it.url, ...dest.value(),
          });
          toast('Added');
          openItem(it.id);
        } }, 'Add'),
        h('button', { class: 'btn', onclick: () => openItem(it.id) }, 'Back'))
    );
  }

  // ---------- Channels ----------

  function renderChannels() {
    const pane = $('#pane-channels');
    const counts = {};
    for (const e of PhoneLib.entries()) if (e.channel != null) counts[e.channel] = (counts[e.channel] || 0) + 1;
    const number = h('input', { type: 'number', min: 1, max: 999, placeholder: 'Number' });
    const name = h('input', { placeholder: 'Channel name' });
    pane.replaceChildren(
      h('h3', null, 'Channels on this device'),
      h('div', { class: 'list' }, PhoneLib.channels().map((c) => h('div', { class: 'item tap', onclick: () => editChannel(c) },
        h('div', { class: 'grow' }, h('div', { class: 't' }, `${c.number}  ${c.name}`), h('div', { class: 's' }, [`${counts[c.number] || 0} videos`, c.mode === 'broadcast' ? 'complete broadcasts' : null, c.blocks && c.blocks.length ? `${c.blocks.length} time blocks` : null, c.rating].filter(Boolean).join(' · ')))))),
      h('h3', null, 'Live channels'),
      h('div', { class: 'list' }, PhoneLib.defaults.live.map((c) => h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, `${c.number}  ${c.name}`), h('div', { class: 's' }, c.description || ''))))),
      h('p', { class: 'muted' }, `Not on the phone: ${PhoneLib.defaults.desktopOnly.map((c) => `${c.number} ${c.name}`).join(', ')}. Those sites only play inside the desktop app.`),
      h('h3', null, 'Add a channel'),
      h('div', { class: 'card' }, h('div', { class: 'grid' }, h('label', null, 'Number', number), h('label', null, 'Name', name)),
        h('button', { class: 'btn primary', onclick: async () => {
          const n = Number(number.value);
          if (!Number.isInteger(n) || n < 1 || n > 999) return toast('Channel numbers are 1 to 999', true);
          if (PhoneLib.channels().some((c) => c.number === n) || PhoneLib.defaults.live.some((c) => c.number === n)) return toast(`Channel ${n} already exists`, true);
          if (!name.value.trim()) return toast('Give it a name', true);
          await PhoneLib.saveChannels([...PhoneLib.channels(), { number: n, name: name.value.trim() }]);
          toast(`Added channel ${n}`);
          renderChannels();
        } }, 'Add channel'))
    );
  }

  function editChannel(c) {
    const name = h('input', { value: c.name });
    const mode = h('select', null, h('option', { value: 'episodes', selected: c.mode !== 'broadcast' }, 'Episodes + inserted ads'), h('option', { value: 'broadcast', selected: c.mode === 'broadcast' }, 'Complete broadcasts'));
    const order = h('select', null, h('option', { value: '' }, 'Default'), h('option', { value: 'shuffle', selected: c.order === 'shuffle' }, 'Shuffle'), h('option', { value: 'sequential', selected: c.order === 'sequential' }, 'In order'));
    const bumpers = h('input', { type: 'number', min: 0, max: 5, value: c.breaks ? c.breaks.bumpers : '' });
    const ads = h('input', { type: 'number', min: 0, max: 12, value: c.breaks ? c.breaks.commercials : '' });
    const rating = ratingSelect(c.rating);
    const blocks = h('textarea', { spellcheck: 'false' }, c.blocks && c.blocks.length ? JSON.stringify(c.blocks, null, 2) : '');
    openSheet(
      h('div', { class: 'row' }, h('b', { style: 'flex:1' }, `Channel ${c.number}`), h('button', { class: 'btn', onclick: closeSheet }, 'Close')),
      h('label', null, 'Name', name),
      h('div', { class: 'grid' }, h('label', null, 'Plays', mode), h('label', null, 'Order', order), h('label', null, 'Bumpers per break', bumpers), h('label', null, 'Ads per break', ads), h('label', { class: 'wide' }, 'Rating', rating)),
      h('label', null, 'Time blocks (same format as the desktop channel.json)', blocks),
      c.note ? h('p', { class: 'muted' }, c.note) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          let b = [];
          if (blocks.value.trim()) {
            try {
              b = JSON.parse(blocks.value);
              if (!Array.isArray(b)) throw new Error('must be a list [ ... ]');
            } catch (e) {
              return toast('Time blocks: ' + e.message, true);
            }
          }
          const next = { ...c, name: name.value.trim() || c.name, mode: mode.value, order: order.value || undefined, rating: rating.value || undefined, blocks: b };
          next.breaks = bumpers.value === '' && ads.value === '' ? undefined : { bumpers: Number(bumpers.value || 0), commercials: Number(ads.value || 0) };
          await PhoneLib.saveChannels(PhoneLib.channels().map((x) => (x.number === c.number ? next : x)));
          closeSheet();
          toast('Saved');
          renderChannels();
        } }, 'Save'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm(`Remove channel ${c.number}? Its videos stay on the device, just not on a channel.`)) return;
          for (const e of PhoneLib.entries().filter((x) => x.channel === c.number)) await PhoneLib.putEntry({ ...e, channel: null });
          await PhoneLib.saveChannels(PhoneLib.channels().filter((x) => x.number !== c.number));
          closeSheet();
          renderChannels();
        } }, 'Remove channel'))
    );
  }

  // ---------- Settings ----------

  // ---------- Home server ----------

  function homeCard() {
    const hs = PhoneLib.home();
    const box = h('div', { class: 'card' });
    if (hs.paired) {
      const shows = (hs.lineup && hs.lineup.channels ? hs.lineup.channels : []).reduce((n, c) => n + c.episodes.length, 0);
      box.append(
        h('b', null, hs.paired.shared ? `Shows shared from ${hs.paired.name}` : `Connected to ${hs.paired.name}`),
        h('p', { class: 'muted' }, hs.up ? `${shows} episodes from the PC are on their channels.` : `Can't reach ${hs.paired.name} right now. Its shows come back when it's on with the home server turned on.`),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => {
            const r = await PhoneLib.refreshHome();
            toast(r === 'ok' ? 'Up to date' : r === 'unpaired' ? 'The PC forgot this device. Connect again.' : "Couldn't reach the PC", r !== 'ok');
            renderSettings();
          } }, 'Check now'),
          hs.paired.shared ? null : h('button', { class: 'btn danger', onclick: async () => {
            await PhoneLib.forgetHome();
            toast('Disconnected');
            renderSettings();
          } }, 'Disconnect'))
      );
      return box;
    }
    const code = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Passcode', autocomplete: 'off' });
    const addr = h('input', { type: 'url', placeholder: 'https://my-pc.example.ts.net', value: hs.here ? hs.here.url : '' });
    const connect = async () => {
      try {
        const url = hs.here ? hs.here.url : addr.value.trim();
        if (!url) return toast('Enter the PC\'s address', true);
        if (location.protocol === 'https:' && /^http:/i.test(url)) return toast(`Open ${url} in Safari instead, and connect from there`, true);
        const r = await PhoneLib.pairHome(url, code.value);
        toast(`Connected to ${r.name}`);
        renderSettings();
      } catch (e) {
        toast(e.message, true);
      }
    };
    box.append(
      h('p', { class: 'muted' }, hs.here
        ? `This page comes from ${hs.here.name}. Enter the passcode from its Library window ("Phone at home" tab) to watch the shows on its drive.`
        : 'Watch the shows on your PC\'s drive: on the PC, open the Library window, "Phone at home" tab, turn it on, and open the address it shows in Safari on this device.'),
      hs.here ? null : addr,
      h('div', { class: 'grid' }, code, h('button', { class: 'btn primary', onclick: connect }, 'Connect'))
    );
    return box;
  }

  // When the app is opened from a PC that hasn't been connected yet, ask for its passcode once.
  function offerPairing() {
    const hs = PhoneLib.home();
    if (!hs.here || hs.paired) return;
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });
    const wrap = el('div');
    wrap.id = 'pairing';
    const card = el('div', 'wn-card');
    const input = el('input', 'pair-code');
    Object.assign(input, { type: 'text', inputMode: 'numeric', placeholder: '000000', autocomplete: 'off', maxLength: 6 });
    const msg = el('div', 'pair-msg', '');
    const ok = el('button', 'wn-ok', 'CONNECT');
    const later = el('button', 'wn-later', 'Not now');
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      msg.textContent = '';
      try {
        await PhoneLib.pairHome(hs.here.url, input.value);
        wrap.remove();
        toastOnTv(`CONNECTED TO ${hs.here.name.toUpperCase()}`);
      } catch (e) {
        msg.textContent = e.message;
      }
      ok.disabled = false;
    });
    later.addEventListener('click', () => wrap.remove());
    card.append(el('div', 'wn-head', 'YOUR PC'), el('div', 'wn-title', `Watch the shows on ${hs.here.name}`), el('div', 'pair-help', 'Enter the passcode shown in its Library window, "Phone at home" tab.'), input, msg, ok, later);
    wrap.append(card);
    document.body.append(wrap);
  }

  const toastOnTv = (text) => TV.osd && TV.osd(text, '', 3000);

  async function renderSettings() {
    const pane = $('#pane-settings');
    const s = PhoneLib.settings();
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
    const isPersisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
    const setup = await DB.get('setup');

    const pin1 = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'New PIN (numbers)' });
    const pin2 = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Same PIN again' });
    const setupInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    setupInput.addEventListener('change', () => setupInput.files[0] && importSetup(setupInput.files[0]).finally(() => (setupInput.value = '')));

    pane.replaceChildren(
      !standalone ? h('div', { class: 'card' }, h('b', null, 'Put Retro TV on your Home Screen'),
        h('p', { class: 'muted' }, 'In Safari, tap the Share button, then "Add to Home Screen". It then opens fullscreen like an app and keeps your videos safe from Safari\'s cleanup.')) : null,
      h('h3', null, 'Shows on your PC'),
      homeCard(),
      h('h3', null, 'PC setup'),
      h('div', { class: 'card' },
        h('p', { class: 'muted' }, 'In the PC\'s Library window, Channels tab, use "Export for phone", put the file on this device, and import it here. You get the same channels, time blocks and profiles, and videos you add are recognized by name.'),
        setup ? h('p', null, `Imported ${new Date(setup.importedAt).toLocaleString()} · ${setup.entries.length} known files`) : null,
        h('button', { class: 'btn primary', onclick: () => setupInput.click() }, 'Import PC setup...'), setupInput),
      h('h3', null, 'PIN'),
      h('div', { class: 'card' },
        h('p', { class: 'muted' }, s.pin ? 'A PIN is set. It locks Late Night and this menu.' : 'No PIN yet. Without one, Late Night and this menu are open to anyone.'),
        h('div', { class: 'grid' }, pin1, pin2),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: async () => {
            if (!/^\d{4,8}$/.test(pin1.value)) return toast('Use 4 to 8 numbers', true);
            if (pin1.value !== pin2.value) return toast("The two PINs don't match", true);
            await PhoneLib.saveSettings({ pin: pin1.value });
            toast('PIN set');
            renderSettings();
          } }, s.pin ? 'Change PIN' : 'Set PIN'),
          s.pin ? h('button', { class: 'btn danger', onclick: async () => {
            await PhoneLib.saveSettings({ pin: '' });
            toast('PIN removed');
            renderSettings();
          } }, 'Remove PIN') : null)),
      h('h3', null, 'Storage'),
      h('div', { class: 'card' },
        h('p', null, est ? `Using ${fmtBytes(est.usage)}${est.quota ? ` of about ${fmtBytes(est.quota)} available to Retro TV` : ''}` : 'Storage size unknown'),
        h('p', { class: 'muted' }, isPersisted ? 'Videos are kept until you delete them.' : 'If the device runs very low on space, iOS may clear Retro TV\'s videos. Keep the originals on your PC.')),
      Report.enabled ? h('h3', null, 'Something wrong?') : null,
      Report.enabled ? h('div', { class: 'card' },
        h('p', { class: 'muted' }, 'Tell us about a problem. What the app was doing is sent along with it.'),
        h('button', { class: 'btn primary', onclick: () => Report.open() }, 'Report a problem')) : null,
      h('h3', null, 'Updates'),
      h('div', { class: 'card' },
        h('p', null, `Version ${window.RTV_DEFAULTS.version}`),
        h('p', { class: 'muted' }, "New versions install by themselves when you open the app. There's no need to remove it from the Home Screen."),
        h('button', { class: 'btn', onclick: async () => {
          const r = await Updates.check().catch(() => 'offline');
          toast({ latest: 'You have the latest version', installing: 'Installing the update...', offline: "Couldn't check: no internet?", unsupported: "Updates aren't available in this browser" }[r], r === 'offline');
        } }, 'Check for updates')),
      Updates.log.length ? h('h3', null, "What's new") : null,
      Updates.log.length ? h('div', { class: 'card' }, ...Updates.entries(Updates.log)) : null
    );
  }

  async function importSetup(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
      if (data.kind !== 'retro-tv-phone-setup') throw new Error();
    } catch {
      return toast('That isn\'t a Retro TV phone setup file', true);
    }
    const { pin, ...settings } = data.settings || {};
    await PhoneLib.saveSettings(settings);
    if (Array.isArray(data.channels) && data.channels.length) await PhoneLib.saveChannels(data.channels);
    const setup = { importedAt: new Date().toISOString(), entries: Array.isArray(data.entries) ? data.entries : [] };
    await DB.set('setup', setup);
    // Videos already on the phone that match get their PC details too.
    let matched = 0;
    for (const e of PhoneLib.entries().filter((x) => x.kind === 'local')) {
      const known = setup.entries.find((s) => s.name === e.name && s.size === e.size) || setup.entries.find((s) => s.name === e.name);
      if (!known) continue;
      const { name, size, ...details } = known;
      await PhoneLib.putEntry({ ...e, ...Object.fromEntries(Object.entries(details).filter(([, v]) => v != null && v !== '')) });
      matched++;
    }
    toast(`PC setup imported: ${(data.channels || []).length} channels${matched ? `, ${matched} videos updated` : ''}`);
    renderSettings();
  }

  return { open, close, isOpen: () => !root.hidden, toast, offerPairing };
})();
