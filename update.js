'use strict';
// Updates and "What's new". A new version downloads in the background when the app opens (or comes
// back to the screen). It installs right away if the TV isn't on yet; otherwise the next time the app
// goes to the background, so a show is never interrupted. After an update, the changes are shown once.
// The list of changes is mobile/changelog.json (built into config.js as RTV_CHANGELOG).

const Updates = (() => {
  const log = window.RTV_CHANGELOG || [];
  const entryId = (e) => `${e.date} ${e.title}`;
  let reg = null;
  let pending = false;
  let reloading = false;

  function install() {
    if (reloading) return;
    reloading = true;
    location.reload();
  }

  if ('serviceWorker' in navigator) {
    // Only an update counts; the very first install has nothing to replace.
    const hadVersion = !!navigator.serviceWorker.controller;
    navigator.serviceWorker
      .register('sw.js')
      .then((r) => (reg = r))
      .catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadVersion) return;
      if (!TV.state.on) return install();
      pending = true;
      if (Manage.isOpen()) Manage.toast('Update downloaded. It installs the next time you open Retro TV.');
      else TV.osd('UPDATE READY', 'INSTALLS NEXT TIME YOU OPEN THE APP', 5000);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (pending) install();
      } else if (reg) {
        reg.update().catch(() => {});
      }
    });
  }

  // Settings' "Check for updates": installs one right away if there is one.
  async function check() {
    if (!reg) return 'unsupported';
    await reg.update();
    const next = reg.installing || reg.waiting;
    if (!next) return 'latest';
    pending = true;
    if (next.state === 'activated') install();
    else next.addEventListener('statechange', () => next.state === 'activated' && install());
    return 'installing';
  }

  // Changes the person hasn't seen yet. Someone who used the app before there was a changelog
  // gets the latest entry; a brand-new install starts clean.
  function unseen() {
    if (!log.length) return [];
    const seen = store.get('seenChangelog', null);
    if (seen === null) return store.get('channel', null) !== null ? log.slice(0, 1) : [];
    const i = log.findIndex((e) => entryId(e) === seen);
    return i < 0 ? log.slice(0, 1) : log.slice(0, i);
  }

  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });

  function entries(list) {
    return list.map((e) => {
      const box = el('div', 'wn-entry');
      const when = new Date(e.date + 'T12:00').toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
      const ul = el('ul');
      for (const c of e.changes || []) ul.append(el('li', '', c));
      box.append(el('div', 'wn-date', when), el('div', 'wn-title', e.title), ul);
      return box;
    });
  }

  // The "What's new" card, shown once after an update (and from Settings).
  function show(list = log.slice(0, 1)) {
    const card = el('div', 'wn-card');
    const ok = el('button', 'wn-ok', 'OK');
    card.append(el('div', 'wn-head', "WHAT'S NEW"), ...entries(list.slice(0, 3)), ok);
    const wrap = el('div');
    wrap.id = 'whatsnew';
    wrap.append(card);
    ok.addEventListener('click', () => wrap.remove());
    wrap.addEventListener('click', (ev) => ev.target === wrap && wrap.remove());
    document.body.append(wrap);
  }

  const fresh = unseen();
  if (log.length) store.set('seenChangelog', entryId(log[0]));
  if (fresh.length) show(fresh);

  return { check, show, entries, log };
})();
