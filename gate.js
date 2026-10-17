// Password gate. If config.js has no passwordHash, the app is open (no gate).
// Hash format: pbkdf2$<iterations>$<saltBase64>$<hashBase64>  (made on set-password.html)
(() => {
  const stored = (window.PIXELSENSE_CONFIG || {}).passwordHash;
  if (!stored) return;

  const read = s => { try { return s.getItem('ps-auth'); } catch { return null; } };
  if (read(localStorage) === stored || read(sessionStorage) === stored) return;

  document.documentElement.classList.add('locked');

  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function matches(password) {
    const [, iter, salt, hash] = stored.split('$');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64(salt), iterations: +iter }, key, 256));
    const want = b64(hash);
    let diff = bits.length ^ want.length;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i];
    return diff === 0;
  }

  let fails = 0;
  document.addEventListener('DOMContentLoaded', () => {
    const gate = document.getElementById('gate'), form = document.getElementById('gateForm');
    const pw = document.getElementById('gatePw'), msg = document.getElementById('gateMsg');
    gate.hidden = false; pw.focus();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('button'); btn.disabled = true; msg.className = 'msg'; msg.textContent = '';
      let ok = false;
      try { ok = await matches(pw.value); } catch { msg.className = 'msg err'; msg.textContent = 'Login needs a secure (https) page.'; }
      if (ok) {
        try { (document.getElementById('gateRemember').checked ? localStorage : sessionStorage).setItem('ps-auth', stored); } catch {}
        document.documentElement.classList.remove('locked'); gate.hidden = true; pw.value = '';
        return;
      }
      if (!msg.textContent) { msg.className = 'msg err'; msg.textContent = 'Wrong password.'; }
      pw.value = ''; pw.focus();
      await new Promise(r => setTimeout(r, Math.min(++fails, 5) * 700)); // slow down guessing
      btn.disabled = false;
    });
  });
})();
