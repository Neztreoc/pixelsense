// Transcript panel: decodes the recording's audio, hands it to the Whisper worker, shows the result.
const Transcript = (() => {
  const $ = id => document.getElementById(id);
  let worker = null, segments = [], busy = false;

  const mmss = s => {
    const p = n => String(n).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(Math.floor(s % 60))}` : `${p(Math.floor(s / 60))}:${p(Math.floor(s % 60))}`;
  };
  const srtTime = s => {
    const ms = Math.round(s * 1000), p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  const mb = b => (b / 1e6).toFixed(0) + ' MB';
  const status = (t, err) => { const m = $('trMsg'); m.className = 'msg' + (err ? ' err' : ''); m.textContent = t; };
  const bar = v => { $('trProgress').hidden = v == null; if (v != null) $('trBar').style.transform = `scaleX(${v})`; };
  const baseName = () => (fileName || 'transcript').replace(/\.webm$/, '');
  const plain = () => segments.map(s => s.text).join('\n');
  const stamped = () => segments.map(s => `[${mmss(s.start)}] ${s.text}`).join('\n');

  async function decode(source) {
    const buf = await source.arrayBuffer();
    const ctx = new AudioContext({ sampleRate: 16000 });
    let audio;
    try { audio = await ctx.decodeAudioData(buf); }
    catch { throw new Error('No audio found in this recording to transcribe.'); }
    finally { ctx.close(); }
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += ch[i] / audio.numberOfChannels;
    }
    return out;
  }

  function render() {
    const box = $('trLines'); box.innerHTML = '';
    segments.forEach(s => {
      const row = document.createElement('div'); row.className = 'tr-row';
      const t = document.createElement('button');
      t.type = 'button'; t.className = 'tr-ts'; t.textContent = mmss(s.start);
      t.onclick = () => { const v = $('preview'); v.currentTime = s.start; v.play(); };
      const p = document.createElement('span'); p.textContent = s.text;
      row.append(t, p); box.appendChild(row);
    });
    $('trActions').hidden = !segments.length;
  }

  function save(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function reset() {
    if (worker && busy) { worker.terminate(); worker = null; } // cancel work in progress
    segments = []; busy = false;
    $('transcript').hidden = true; $('trLines').innerHTML = ''; $('trActions').hidden = true;
    bar(null); status('');
    const b = $('transcribeBtn'); if (b) { b.disabled = false; b.textContent = 'Transcribe'; }
  }

  async function run() {
    if (busy) return;
    const source = (typeof audioBlob !== 'undefined' && audioBlob) || blob; // small audio-only copy if we have it
    if (!source) return;
    busy = true; segments = [];
    $('transcribeBtn').disabled = true; $('transcribeBtn').textContent = 'Transcribing…';
    $('transcript').hidden = false; $('trLines').innerHTML = ''; $('trActions').hidden = true;
    status('Preparing audio…'); bar(0);
    try {
      const audio = await decode(source);
      if (!worker) worker = new Worker('transcribe-worker.js', { type: 'module' });
      const w = worker;
      const finished = new Promise((resolve, reject) => {
        w.onmessage = ({ data }) => {
          if (data.type === 'load') { bar(data.loaded / data.total); status(`Downloading speech model (first time only)… ${mb(data.loaded)} of ${mb(data.total)}`); }
          else if (data.type === 'device') status(`Speech model ready (${data.device}).`);
          else if (data.type === 'ready') { bar(0); status('Transcribing…'); }
          else if (data.type === 'progress') { bar(data.value); status(`Transcribing… ${Math.round(data.value * 100)}%`); }
          else if (data.type === 'done') resolve(data.chunks);
          else if (data.type === 'error') reject(new Error(data.message));
        };
        w.onerror = e => reject(new Error(e.message || 'The speech engine failed to start. Check your internet connection.'));
      });
      w.postMessage({ type: 'transcribe', audio }, [audio.buffer]);
      const chunks = await finished;
      segments = chunks
        .map(c => ({ start: (c.timestamp && c.timestamp[0]) || 0, end: c.timestamp && c.timestamp[1], text: (c.text || '').trim() }))
        .filter(s => s.text);
      segments.forEach((s, i) => { if (s.end == null) s.end = (segments[i + 1] ? segments[i + 1].start : s.start + 4); });
      bar(null);
      status(segments.length ? `Done. ${segments.length} lines. Click a time to jump to it in the video.` : 'No speech was found in this recording.');
      render();
    } catch (e) {
      bar(null); status(e.message, true);
      if (worker) { worker.terminate(); worker = null; }
    }
    busy = false;
    $('transcribeBtn').disabled = false; $('transcribeBtn').textContent = 'Transcribe again';
  }

  $('transcribeBtn').onclick = run;
  $('trCopy').onclick = async () => { await navigator.clipboard.writeText(plain()); $('trCopy').textContent = 'Copied'; setTimeout(() => $('trCopy').textContent = 'Copy', 1500); };
  $('trTxt').onclick = () => save(baseName() + '.txt', stamped(), 'text/plain');
  $('trSrt').onclick = () => save(baseName() + '.srt',
    segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n'), 'application/x-subrip');

  return { reset };
})();
