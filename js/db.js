// Local storage of all documents and pages in IndexedDB.
// Image data is stored as ArrayBuffer (more robust than Blobs in older Safari versions).

const DB_NAME = 'scan-app';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) {
          db.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const reqP = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const done = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
});

export async function getAllDocs() {
  const db = await openDb();
  return reqP(db.transaction('docs').objectStore('docs').getAll());
}

export async function getDoc(id) {
  const db = await openDb();
  return reqP(db.transaction('docs').objectStore('docs').get(id));
}

export async function putDoc(doc) {
  const db = await openDb();
  const tx = db.transaction('docs', 'readwrite');
  tx.objectStore('docs').put(doc);
  return done(tx);
}

export async function deleteDoc(doc) {
  const db = await openDb();
  const tx = db.transaction(['docs', 'pages'], 'readwrite');
  tx.objectStore('docs').delete(doc.id);
  const pages = tx.objectStore('pages');
  for (const id of doc.pageIds || []) pages.delete(id);
  const cur = pages.index('docId').openCursor(IDBKeyRange.only(doc.id));
  cur.onsuccess = () => {
    const c = cur.result;
    if (c) { c.delete(); c.continue(); }
  };
  return done(tx);
}

export async function getPages(ids) {
  const db = await openDb();
  const store = db.transaction('pages').objectStore('pages');
  const res = await Promise.all(ids.map((id) => reqP(store.get(id))));
  return res.filter(Boolean);
}

export async function putPage(page) {
  const db = await openDb();
  const tx = db.transaction('pages', 'readwrite');
  tx.objectStore('pages').put(page);
  return done(tx);
}

export async function deletePage(id) {
  const db = await openDb();
  const tx = db.transaction('pages', 'readwrite');
  tx.objectStore('pages').delete(id);
  return done(tx);
}
