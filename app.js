const $ = id => document.getElementById(id);
const stage = $('stage'), preview = $('preview'), recBtn = $('recBtn'), badge = $('badge');
const timerEl = $('timer'), hint = $('hint'), micToggle = $('micToggle');
const result = $('result'), msg = $('msg'), progress = $('progress'), bar = $('bar');
const driveBtn = $('driveBtn'), driveStatus = $('driveStatus');

let noSystemAudio = false, restarting = false;
let recorder, streams = [], audioCtx, tick, startedAt, blob, blobUrl, fileName, token;
const MIC_BOOST = 2.5; // microphone volume multiplier (1 = unchanged)
let audioRec = null, audioChunks = [], audioBlob = null; // small audio-only copy, used for transcription
let sid = null, seq = 0, pending = Promise.resolve(), spill = new Map(), currentSid = null;

const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const say = (t, err) => { msg.className = 'msg' + (err ? ' err' : ''); msg.innerHTML = t; };
const size = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB';

async function start() {
  clearResult();
  let screen;
  try {
    // The picker UI belongs to the browser; these are hints it may honour (Chromium).
    screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, displaySurface: 'monitor' },
      audio: true,
      systemAudio: 'include',
      monitorTypeSurfaces: 'include',
      selfBrowserSurface: 'exclude'
    });
  } catch { return; } // user cancelled the picker
  streams = [screen];

  const tracks = [...screen.getVideoTracks()];
  const ctx = new AudioContext(); audioCtx = ctx;
  const dest = ctx.createMediaStreamDestination();
  let hasAudio = false, sysAn = null, micAn = null;

  if (screen.getAudioTracks().length) {
    const sysSrc = ctx.createMediaStreamSource(new MediaStream(screen.getAudioTracks()));
    sysSrc.connect(dest); sysAn = Meters.tap(ctx, sysSrc); hasAudio = true;
  }
  if (micToggle.checked) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streams.push(mic);
      // Boost a quiet mic, with a limiter so loud speech doesn't distort.
      const gain = ctx.createGain(); gain.gain.value = MIC_BOOST;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10; limiter.knee.value = 10; limiter.ratio.value = 6;
      limiter.attack.value = 0.003; limiter.release.value = 0.25;
      ctx.createMediaStreamSource(mic).connect(gain).connect(limiter).connect(dest);
      micAn = Meters.tap(ctx, limiter); hasAudio = true;
    } catch { say('Microphone unavailable, recording without it.', true); }
  }
  if (hasAudio) tracks.push(...dest.stream.getAudioTracks());

  const out = new MediaStream(tracks);
  preview.srcObject = out; preview.play();
  stage.classList.add('has-video', 'live');

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  sid = Date.now().toString(36); seq = 0; spill = new Map(); pending = Promise.resolve();
  fileName = makeFileName();
  pending = Store.putSession(sid, fileName, Date.now()).catch(() => {});
  navigator.storage && navigator.storage.persist && navigator.storage.persist();
  // Each chunk goes straight to disk (IndexedDB). If a write fails, keep that chunk in memory instead.
  recorder.ondataavailable = e => {
    if (!e.data.size) return;
    const n = seq++;
    pending = pending.then(() => Store.putChunk(sid, n, e.data)).catch(() => spill.set(n, e.data));
  };
  recorder.onstop = finish;
  recorder.start(1000);

  audioRec = null; audioChunks = []; audioBlob = null;
  if (hasAudio) {
    try {
      audioRec = new MediaRecorder(new MediaStream(dest.stream.getAudioTracks()), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
      audioRec.ondataavailable = e => e.data.size && audioChunks.push(e.data);
      audioRec.onstop = () => { audioBlob = audioChunks.length ? new Blob(audioChunks, { type: 'audio/webm' }) : null; };
      audioRec.start(5000);
    } catch { audioRec = null; }
  }

  screen.getVideoTracks()[0].addEventListener('ended', stop); // browser "Stop sharing" bar
  startedAt = Date.now();
  tick = setInterval(() => timerEl.textContent = fmt((Date.now() - startedAt) / 1000), 250);
  badge.hidden = false; timerEl.textContent = '00:00';
  Meters.start(sysAn, micAn);
  recBtn.classList.add('recording'); recBtn.setAttribute('aria-label', 'Stop recording');
  noSystemAudio = screen.getAudioTracks().length === 0;
  hint.textContent = noSystemAudio ? 'Recording. No system audio captured. Stop and tick "Share system audio" next time.' : 'Recording…';
  hint.classList.toggle('warn', noSystemAudio);
  if (noSystemAudio) $('audioDialog').showModal();
}

function stop() {
  if (audioRec && audioRec.state !== 'inactive') audioRec.stop();
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

const makeFileName = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `pixelsense-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.webm`;
};

function showResult(b, name, id) {
  blob = b; fileName = name; currentSid = id;
  blobUrl = URL.createObjectURL(blob);
  stage.classList.add('has-video');
  preview.srcObject = null; preview.src = blobUrl; preview.muted = false; preview.controls = true;
  $('fileName').textContent = fileName; $('fileSize').textContent = size(blob.size);
  result.hidden = false; say('');
}

async function finish() {
  clearInterval(tick);
  Meters.stop();
  streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  audioCtx && audioCtx.close();
  badge.hidden = true; stage.classList.remove('live');
  recBtn.classList.remove('recording'); recBtn.setAttribute('aria-label', 'Start recording');
  hint.textContent = 'Choose a screen, window or tab';
  hint.classList.remove('warn');

  await pending; // let the last chunk finish writing
  if (restarting) { restarting = false; Store.remove(sid).catch(() => {}); return start(); }

  const parts = await assemble(sid, spill);
  showResult(parts, fileName, sid);
}

async function assemble(id, extra = new Map()) {
  const stored = await Store.getChunks(id).catch(() => []);
  const all = new Map(stored.map(c => [c.seq, c.data]));
  extra.forEach((d, n) => all.set(n, d));
  return new Blob([...all.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]), { type: 'video/webm' });
}

function markDone() {
  $('discardBtn').textContent = 'Close';
}

function clearResult() {
  $('discardBtn').textContent = 'Discard';
  if (typeof Transcript !== 'undefined') Transcript.reset();
  audioBlob = null;
  if (currentSid) { Store.remove(currentSid).catch(() => {}); currentSid = null; }
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blob = blobUrl = null; result.hidden = true; progress.hidden = true; bar.style.transform = 'scaleX(0)';
  preview.removeAttribute('src'); preview.controls = false; preview.muted = true; preview.load();
  stage.classList.remove('has-video'); driveBtn.disabled = false;
}

$('continueBtn').onclick =() => $('audioDialog').close();
$('restartBtn').onclick = () => { $('audioDialog').close(); restarting = true; stop(); };
recBtn.onclick =() => (recorder && recorder.state === 'recording') ? stop() : start();
$('discardBtn').onclick = clearResult;
$('downloadBtn').onclick = () => {
  const a = document.createElement('a'); a.href = blobUrl; a.download = fileName; a.click();
  markDone();
};

// ---- Google Drive -------------------------------------------------------
const clientId = (window.PIXELSENSE_CONFIG || {}).googleClientId;

function getToken() {
  return new Promise((resolve, reject) => {
    if (!clientId) return reject(new Error('Add your Google Client ID to config.js first.'));
    if (!window.google || !google.accounts) return reject(new Error('Google sign-in is still loading, try again.'));
    google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: r => r.access_token ? resolve(r.access_token) : reject(new Error(r.error || 'Sign-in failed')),
      error_callback: e => reject(new Error(e.message || 'Sign-in cancelled'))
    }).requestAccessToken();
  });
}

function upload(accessToken, file, name) {
  return new Promise(async (resolve, reject) => {
    const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/webm' },
      body: JSON.stringify({ name, mimeType: 'video/webm' })
    });
    if (!init.ok) return reject(new Error('Drive refused the upload (' + init.status + ').'));
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', init.headers.get('Location'));
    xhr.upload.onprogress = e => e.lengthComputable && (bar.style.transform = `scaleX(${e.loaded / e.total})`);
    xhr.onload = () => xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error('Upload failed (' + xhr.status + ').'));
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(file);
  });
}

driveBtn.onclick = async () => {
  driveBtn.disabled = true; say('Connecting to Google…');
  try {
    token = token || await getToken();
    driveStatus.textContent = 'Drive: connected'; driveStatus.classList.add('on');
    progress.hidden = false; bar.style.transform = 'scaleX(0)'; say('Uploading…');
    const f = await upload(token, blob, fileName);
    bar.style.transform = 'scaleX(1)';
    say(`Saved to Drive. <a href="${f.webViewLink}" target="_blank" rel="noopener">Open file</a>`);
    markDone();
  } catch (e) {
    token = null; say(e.message, true); driveBtn.disabled = false;
  }
};

driveStatus.onclick = async () => {
  try { token = await getToken(); driveStatus.textContent = 'Drive: connected'; driveStatus.classList.add('on'); }
  catch (e) { if (!result.hidden) say(e.message, true); else alert(e.message); }
};

// ---- Recover an interrupted recording -----------------------------------
const recoverBox = $('recover');
let recoverItem = null;

async function checkRecover() {
  try {
    const [first] = (await Store.list()).filter(s => s.sid !== currentSid);
    recoverItem = first || null;
  } catch { recoverItem = null; }
  recoverBox.hidden = !recoverItem;
  if (recoverItem) {
    $('recoverText').textContent =
      `Unsaved recording found from ${new Date(recoverItem.startedAt).toLocaleString()} (${size(recoverItem.size)}).`;
  }
}

$('recoverBtn').onclick = async () => {
  const item = recoverItem; if (!item) return;
  clearResult();
  showResult(await assemble(item.sid), item.fileName, item.sid);
  checkRecover();
};
$('recoverDelete').onclick = async () => {
  if (recoverItem) await Store.remove(recoverItem.sid).catch(() => {});
  checkRecover();
};

window.addEventListener('beforeunload', e => {
  if (recorder && recorder.state === 'recording') e.preventDefault();
});

if (window.indexedDB) checkRecover();

// ---- Rotating background -------------------------------------------------
const scenes = ['observatory', 'harbour', 'ruins', 'oasis'];
const layers = [...document.querySelectorAll('.bg-layer')];
let front = 1, currentScene = -1;

async function nextScene() {
  let i;
  do { i = Math.floor(Math.random() * scenes.length); } while (i === currentScene);
  const url = `art/${scenes[i]}.webp`;
  await new Promise(done => { const im = new Image(); im.onload = im.onerror = done; im.src = url; }); // load before fading in
  const incoming = layers[front ^ 1], outgoing = layers[front];
  incoming.style.backgroundImage = `url(${url})`;
  incoming.classList.add('on'); outgoing.classList.remove('on');
  front ^= 1; currentScene = i;
}
nextScene();
setInterval(() => { if (!document.hidden) nextScene(); }, 20000);

if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
  recBtn.disabled = true; hint.textContent = 'Screen recording is not supported on this device';
}
