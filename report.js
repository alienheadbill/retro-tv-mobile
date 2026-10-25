'use strict';
// "Report a problem": a short note from whoever is watching, sent to the app's owner by email
// through Web3Forms (free, web3forms.com). The owner's address never appears in the app; only
// the access key Web3Forms emails them, set as settings.reports.web3formsKey in channels.json.
// Each report comes with what the app was doing: version, device, channel, what was on, and the
// last few errors. Loaded early so it catches errors from the start.

const Report = (() => {
  const cfg = ((window.RTV_DEFAULTS || {}).settings || {}).reports || {};
  const key = cfg.web3formsKey || null;
  const errors = [];

  const remember = (msg) => {
    errors.push(`${new Date().toISOString().slice(11, 19)} ${String(msg).slice(0, 300)}`);
    if (errors.length > 10) errors.shift();
  };
  window.addEventListener('error', (e) => remember(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => remember(`Unhandled: ${(e.reason && e.reason.message) || e.reason}`));

  function details() {
    const lines = [`Version: ${(window.RTV_DEFAULTS || {}).version}`, `Device: ${navigator.userAgent}`, `Screen: ${innerWidth}x${innerHeight} (${matchMedia('(orientation: landscape)').matches ? 'sideways' : 'upright'})`];
    lines.push(`Installed on Home Screen: ${navigator.standalone || matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'}`, `Online: ${navigator.onLine ? 'yes' : 'no'}`);
    try {
      const vv = window.visualViewport;
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'none';
        const r = el.getBoundingClientRect();
        return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      };
      lines.push(`Zoom: ${vv ? vv.scale.toFixed(2) : '?'} (visible ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)}` : '?'})`, `TV box: ${box('#tv')}`, `YouTube picture: ${box('#yt-host iframe')}`);
    } catch {}
    try {
      const s = TV.state;
      const ch = s.channels[s.index];
      if (ch) lines.push(`Channel: ${ch.number} ${ch.name} (${ch.source || ch.type})`);
      const now = TV.nowPlaying && TV.nowPlaying();
      if (now) lines.push(`Playing: ${now}`);
      lines.push(`Profile: ${s.profile || 'none'}`, `TV on: ${s.on ? 'yes' : 'no'}`);
    } catch {}
    try {
      const hs = PhoneLib.home();
      if (hs.paired) lines.push(`Shows from a PC: ${hs.paired.name} (${hs.up ? 'reachable' : 'not reachable'})`);
    } catch {}
    lines.push('Recent errors:', ...(errors.length ? errors : ['none']));
    return lines.join('\n');
  }

  async function send(text, contact) {
    if (!key) throw new Error("Reports aren't set up on this app yet");
    const body = {
      access_key: key,
      subject: `Retro TV problem report: ${text.slice(0, 60)}`,
      from_name: 'Retro TV',
      message: `${text}\n\n${contact ? `Reply to: ${contact}\n\n` : ''}--- What the app was doing ---\n${details()}`,
    };
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact || '')) body.email = contact; // lets the owner reply
    let r;
    try {
      r = await fetch('https://api.web3forms.com/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new Error("Couldn't send: no internet?");
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.message || `Couldn't send (${r.status})`);
  }

  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });

  // The report card, over whatever is on screen.
  function open() {
    if (document.querySelector('#report')) return;
    const wrap = el('div');
    wrap.id = 'report';
    const card = el('div', 'wn-card');
    const what = el('textarea', 'report-text');
    what.placeholder = 'What went wrong? (What were you watching, what did you tap?)';
    what.rows = 5;
    const contact = el('input', 'report-contact');
    Object.assign(contact, { type: 'text', placeholder: 'Your name or email (optional)', autocomplete: 'email' });
    const msg = el('div', 'pair-msg', '');
    const sendBtn = el('button', 'wn-ok', 'SEND');
    const cancel = el('button', 'wn-later', 'Cancel');
    const close = () => wrap.remove();
    sendBtn.addEventListener('click', async () => {
      const text = what.value.trim();
      if (text.length < 3) return (msg.textContent = 'Say a few words about what went wrong.');
      sendBtn.disabled = true;
      msg.textContent = '';
      try {
        await send(text, contact.value.trim());
        card.replaceChildren(el('div', 'wn-head', 'THANKS!'), el('div', 'pair-help', 'Your report was sent.'), cancel);
        cancel.textContent = 'Close';
      } catch (e) {
        msg.textContent = e.message;
        sendBtn.disabled = false;
      }
    });
    cancel.addEventListener('click', close);
    card.append(el('div', 'wn-head', 'REPORT A PROBLEM'), what, contact,
      el('div', 'report-note', "The app's version, this device's type and what was on are sent along with it."), msg, sendBtn, cancel);
    wrap.append(card);
    document.body.append(wrap);
    what.focus();
  }

  return { enabled: !!key, open, details };
})();
