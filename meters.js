// Two small pixel-style level meters (MIC and SYS) that light up when sound is actually coming in.
const Meters = (() => {
  const SEGS = 12;
  let raf = 0, rows = [];

  const tap = (ctx, node) => { // side branch for measuring only; does not change what is recorded
    const an = ctx.createAnalyser(); an.fftSize = 1024; node.connect(an); return an;
  };

  const level = row => {
    row.an.getByteTimeDomainData(row.buf);
    let sum = 0;
    for (let i = 0; i < row.buf.length; i++) { const x = (row.buf[i] - 128) / 128; sum += x * x; }
    return Math.min(1, Math.pow(Math.sqrt(sum / row.buf.length) * 5, 0.7));
  };

  function frame() {
    for (const r of rows) {
      if (!r.an) continue;
      r.lvl = Math.max(level(r), r.lvl * 0.88); // quick attack, slow release
      const lit = Math.round(r.lvl * SEGS);
      if (lit === r.lit) continue;
      r.lit = lit;
      r.segs.forEach((s, i) => { s.className = i < lit ? (i >= SEGS - 2 ? 'hi' : i >= SEGS - 5 ? 'mid' : 'on') : ''; });
    }
    raf = requestAnimationFrame(frame);
  }

  function setup(boxId, segsId, an) {
    const box = document.getElementById(boxId), el = document.getElementById(segsId);
    el.innerHTML = '';
    const segs = [...Array(SEGS)].map(() => el.appendChild(document.createElement('i')));
    box.classList.toggle('off', !an);
    box.title = an ? '' : 'Not recording this source';
    return { an, segs, buf: an ? new Uint8Array(an.fftSize) : null, lvl: 0, lit: -1 };
  }

  function start(sysAn, micAn) {
    rows = [setup('sysMeter', 'sysSegs', sysAn), setup('micMeter', 'micSegs', micAn)];
    document.getElementById('meters').hidden = false;
    cancelAnimationFrame(raf); frame();
  }

  function stop() {
    cancelAnimationFrame(raf); rows = [];
    document.getElementById('meters').hidden = true;
  }

  return { tap, start, stop };
})();
