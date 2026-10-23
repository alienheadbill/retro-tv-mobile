'use strict';
// On-device storage (IndexedDB): video files, their details, channels and settings.
// Nothing here ever leaves the phone.

const DB = (() => {
  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const r = indexedDB.open('retrotv', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('blobs'); // id -> File/Blob
          d.createObjectStore('entries', { keyPath: 'id' }); // details of each video
          d.createObjectStore('kv'); // channels, settings
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return opening;
  }

  const result = (r) =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

  const finished = (t) =>
    new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error || new Error('Storage failed'));
    });

  async function get(store, key) {
    const d = await open();
    return result(d.transaction(store).objectStore(store).get(key));
  }

  async function all(store) {
    const d = await open();
    return result(d.transaction(store).objectStore(store).getAll());
  }

  async function put(store, value, key) {
    const d = await open();
    const t = d.transaction(store, 'readwrite');
    key === undefined ? t.objectStore(store).put(value) : t.objectStore(store).put(value, key);
    return finished(t);
  }

  async function del(store, key) {
    const d = await open();
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    return finished(t);
  }

  // A full phone shows up as a QuotaExceededError; say it plainly.
  const friendly = (e) =>
    e && /quota/i.test(e.name + e.message) ? new Error('The phone is out of space for Retro TV. Free some space or remove videos.') : e;

  return {
    entries: () => all('entries'),
    entry: (id) => get('entries', id),
    putEntry: (e) => put('entries', e).catch((e2) => Promise.reject(friendly(e2))),
    deleteEntry: async (id) => {
      await del('blobs', id);
      await del('entries', id);
    },
    blob: (id) => get('blobs', id),
    putBlob: (id, blob) => put('blobs', blob, id).catch((e) => Promise.reject(friendly(e))),
    get: (key) => get('kv', key),
    set: (key, value) => put('kv', value, key),
  };
})();
