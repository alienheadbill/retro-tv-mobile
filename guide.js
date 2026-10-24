'use strict';
// The cable guide channel: current channel playing in the corner, a grid of what's on below.
// Leave it alone for a while and it starts scrolling by itself, like the real thing.

const Guide = (() => {
  const el = document.getElementById('guide');
  const head = el.querySelector('.guide-head');
  const rows = el.querySelector('.guide-rows');
  const clock = el.querySelector('.guide-clock');
  const pick = el.querySelector('.guide-pick');
  const SLOT = 30 * 60 * 1000;
  const SLOTS = 4;
  const ROWS_VISIBLE = 6;

  // api.scroll (the phone): every channel in a list you scroll with your finger, instead of six
  // rows moved with the remote; no auto-scrolling.
  let api = null; // { channels, current, listings(ch, from, to), tune(i), scroll? }
  let sel = 0;
  let top = 0;
  let idle = 0;
  let timer = 0;

  const fmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function render() {
    const now = Date.now();
    const from = Math.floor(now / SLOT) * SLOT;
    const to = from + SLOT * SLOTS;
    clock.textContent = fmt(now);

    head.innerHTML = '<div class="chcol"></div><div class="times"></div>';
    for (let i = 0; i < SLOTS; i++) {
      const d = document.createElement('div');
      d.textContent = fmt(from + i * SLOT);
      head.lastChild.appendChild(d);
    }

    const chans = api.channels;
    if (sel < top) top = sel;
    if (sel >= top + ROWS_VISIBLE) top = sel - ROWS_VISIBLE + 1;
    const first = api.scroll ? 0 : top;
    const last = api.scroll ? chans.length : Math.min(chans.length, top + ROWS_VISIBLE);
    const scrolled = rows.scrollTop;
    rows.innerHTML = '';
    for (let i = first; i < last; i++) {
      const ch = chans[i];
      const row = document.createElement('div');
      row.className = 'guide-row' + (i === sel ? ' sel' : '') + (i === api.current() ? ' tuned' : '');
      const cc = document.createElement('div');
      cc.className = 'chcol';
      cc.innerHTML = '<b></b><span></span>';
      cc.firstChild.textContent = ch.number;
      cc.lastChild.textContent = ch.name;
      const progs = document.createElement('div');
      progs.className = 'progs';
      for (const p of api.listings(ch, from, to)) {
        const s = Math.max(p.start, from);
        const e = Math.min(p.end, to);
        if (e <= s) continue;
        const cell = document.createElement('div');
        cell.className = 'prog';
        cell.style.left = ((s - from) / (to - from)) * 100 + '%';
        cell.style.width = ((e - s) / (to - from)) * 100 + '%';
        if (p.live) {
          const tag = document.createElement('span');
          tag.className = p.off ? 'live off' : 'live';
          tag.textContent = p.off ? 'OFF AIR' : 'LIVE';
          cell.appendChild(tag);
        }
        cell.appendChild(document.createTextNode(p.title));
        progs.appendChild(cell);
      }
      row.append(cc, progs);
      // Touch screens (the phone app): tap a row to tune it.
      row.addEventListener('click', () => {
        close();
        api.tune(i);
      });
      rows.appendChild(row);
    }
    if (api.scroll) rows.scrollTop = scrolled;

    const ch = chans[sel];
    const now0 = api.listings(ch, now, now + 1)[0];
    pick.innerHTML = '<div class="t"></div><div class="s"></div>';
    pick.firstChild.textContent = `${ch.number}  ${ch.name}`;
    pick.lastChild.textContent = !now0
      ? ''
      : now0.live
        ? (now0.off ? 'Off the air right now. ' : '') + now0.title
        : `${now0.title}  (${fmt(now0.start)} – ${fmt(now0.end)})`;
  }

  function step() {
    idle++;
    if (api.scroll) {
      // Refresh the listings now and then; keep the clock ticking.
      if (idle % 30 === 0) render();
      else clock.textContent = fmt(Date.now());
      return;
    }
    // After ~10s untouched, scroll through the channels on its own.
    if (idle > 10 && idle % 3 === 0) sel = (sel + 1) % api.channels.length;
    render();
  }

  function open(a) {
    api = a;
    sel = api.current();
    idle = 0;
    el.hidden = false;
    document.body.classList.add('guide-open');
    rows.scrollTop = 0;
    render();
    if (api.scroll && rows.children[sel]) rows.children[sel].scrollIntoView({ block: 'center' });
    timer = setInterval(step, 1000);
  }

  function close() {
    clearInterval(timer);
    el.hidden = true;
    document.body.classList.remove('guide-open');
  }

  function key(e) {
    idle = 0;
    const n = api.channels.length;
    if (e.key === 'ArrowDown') sel = (sel + 1) % n;
    else if (e.key === 'ArrowUp') sel = (sel - 1 + n) % n;
    else if (e.key === 'PageDown') sel = Math.min(n - 1, sel + ROWS_VISIBLE);
    else if (e.key === 'PageUp') sel = Math.max(0, sel - ROWS_VISIBLE);
    else if (e.key === 'Enter') {
      const i = sel;
      close();
      api.tune(i);
      return true;
    } else if (e.key === 'Escape' || e.key.toLowerCase() === 'g') {
      close();
      return true;
    } else return false;
    render();
    return true;
  }

  return { open, close, key, isOpen: () => !el.hidden, scrollBy: (d) => key({ key: d > 0 ? 'ArrowDown' : 'ArrowUp' }) };
})();
