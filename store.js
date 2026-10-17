// Crash-safe storage: every recorded chunk is written to the browser's IndexedDB as it arrives,
// so an interrupted recording can be recovered on the next visit.
const Store = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('pixelsense', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('sessions', { keyPath: 'sid' });
      req.result.createObjectStore('chunks', { keyPath: ['sid', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));

  const run = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let out;
      Promise.resolve(fn(tx)).then(v => { out = v; }, reject);
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  };
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const range = sid => IDBKeyRange.bound([sid, 0], [sid, Infinity]);

  return {
    putSession: (sid, fileName, startedAt) =>
      run('sessions', 'readwrite', tx => req(tx.objectStore('sessions').put({ sid, fileName, startedAt }))),
    putChunk: (sid, seq, data) =>
      run('chunks', 'readwrite', tx => req(tx.objectStore('chunks').put({ sid, seq, data }))),
    getChunks: sid =>
      run('chunks', 'readonly', tx => req(tx.objectStore('chunks').getAll(range(sid)))),
    async list() {
      const sessions = await run('sessions', 'readonly', tx => req(tx.objectStore('sessions').getAll()));
      const out = [];
      for (const s of sessions) {
        const chunks = await this.getChunks(s.sid);
        if (!chunks.length) { await this.remove(s.sid); continue; } // nothing recorded, tidy up
        out.push({ ...s, size: chunks.reduce((n, c) => n + c.data.size, 0) });
      }
      return out.sort((a, b) => b.startedAt - a.startedAt);
    },
    remove: sid => run(['sessions', 'chunks'], 'readwrite', tx => {
      tx.objectStore('chunks').delete(range(sid));
      tx.objectStore('sessions').delete(sid);
    })
  };
})();
