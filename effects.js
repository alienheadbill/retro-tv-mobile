'use strict';
// Snow between channels (picture and that hiss) and the power-on/off animation.

const Effects = (() => {
  const canvas = document.getElementById('static');
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(canvas.width, canvas.height);
  let frame = 0;
  let hideTimer = 0;
  let audio = null;
  let hiss = null;

  function draw() {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    // A brighter rolling band, like a weak signal.
    const band = (performance.now() / 6) % canvas.height;
    for (let y = band; y < band + 12 && y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (Math.floor(y) * canvas.width + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = Math.min(255, d[i] + 60);
      }
    }
    ctx.putImageData(img, 0, 0);
    frame = requestAnimationFrame(draw);
  }

  function noiseBuffer(ac) {
    const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    return buf;
  }

  function startHiss(volume) {
    try {
      audio = audio || new AudioContext();
      const src = audio.createBufferSource();
      src.buffer = noiseBuffer(audio);
      src.loop = true;
      const filter = audio.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 900;
      const gain = audio.createGain();
      gain.gain.value = 0.12 * volume;
      src.connect(filter).connect(gain).connect(audio.destination);
      src.start();
      hiss = src;
    } catch {
      hiss = null;
    }
  }

  function stopHiss() {
    if (hiss) {
      try { hiss.stop(); } catch {}
      hiss = null;
    }
  }

  function snow(ms, volume) {
    clearTimeout(hideTimer);
    if (!frame) draw();
    canvas.classList.add('on');
    stopHiss();
    if (volume > 0) startHiss(volume);
    hideTimer = setTimeout(() => {
      canvas.classList.remove('on');
      cancelAnimationFrame(frame);
      frame = 0;
      stopHiss();
    }, ms);
  }

  function power(kind) {
    const el = document.getElementById('power');
    el.className = '';
    void el.offsetWidth; // restart the animation
    el.className = kind;
    return new Promise((r) => setTimeout(r, kind === 'on' ? 1150 : 600));
  }

  return { snow, power };
})();
