// Remember a local imports folder (Chrome/Edge desktop: File System Access API).
// The folder handle is stored in IndexedDB on this device only; files are read only when you click.
const DB = "pt-folder", STORE = "h", KEY = "imports";

export const supported = () => typeof window !== "undefined" && "showDirectoryPicker" in window && "indexedDB" in window;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction(STORE, mode);
      const r = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const get = () => idb("readonly", (s) => s.get(KEY)).catch(() => null);

export async function name() { return (await get())?.name || null; }

export async function pick() {
  const handle = await window.showDirectoryPicker({ id: "portfolio-imports", mode: "read" });
  await idb("readwrite", (s) => s.put(handle, KEY));
  return handle.name;
}

/** Newest file in the remembered folder whose name matches `re`. Asks for permission again if needed. */
export async function newest(re) {
  const handle = await get();
  if (!handle) throw new Error("Choose the imports folder first.");
  if ((await handle.queryPermission({ mode: "read" })) !== "granted" && (await handle.requestPermission({ mode: "read" })) !== "granted")
    throw new Error("Permission to read the folder was not given.");
  let best = null;
  for await (const entry of handle.values()) {
    if (entry.kind !== "file" || !re.test(entry.name)) continue;
    const f = await entry.getFile();
    if (!best || f.lastModified > best.lastModified) best = f;
  }
  return best;
}
