// zotero.js — clients for Zotero's local API (reads) and web API (writes/fallbacks)

import { requestWithRetry, HttpTimeout } from "./http.js";

const LOCAL_BASE = process.env.ZOTERO_LOCAL_BASE || "http://127.0.0.1:23119/api";
const WEB_BASE = process.env.ZOTERO_WEB_BASE || "https://api.zotero.org";
const API_KEY = process.env.ZOTERO_API_KEY || "";

function envInt(name, fallback, min, max) {
  const v = parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// Deadlines. Anything slower than these is treated as a stall, not as slow-but-working.
export const LOCAL_TIMEOUT_MS = envInt("ZOTERO_LOCAL_TIMEOUT_MS", 20000, 2000, 300000);
export const WEB_TIMEOUT_MS = envInt("ZOTERO_WEB_TIMEOUT_MS", 30000, 2000, 300000);
// Full text of a long book and whole-collection exports are legitimately slow.
export const SLOW_TIMEOUT_MS = Math.max(LOCAL_TIMEOUT_MS * 3, 60000);

let cachedUserID = null;
let cachedGroups = null; // [{id, name}]

export class ZoteroError extends Error {}

function localUnreachableMsg() {
  return (
    "Could not reach Zotero on this computer. Please check that (1) the Zotero app is open, and " +
    "(2) in Zotero's Settings → Advanced, the box 'Allow other applications on this computer to " +
    "communicate with Zotero' is checked. Then try again."
  );
}

function localTimeoutMsg(ms) {
  return (
    `Zotero accepted the connection but sent no reply within ${Math.round(ms / 1000)} seconds, on two ` +
    "attempts. Zotero's local API has most likely stopped responding, which tends to happen after the " +
    "app has been open for a long stretch. Quit Zotero and open it again, then retry. Nothing was " +
    "changed. If this happens on large requests rather than after long uptime, raise the local timeout " +
    "in Claude Desktop → Settings → Extensions → Zotero Connector."
  );
}

async function localFetch(path, opts = {}) {
  const timeoutMs = opts.timeoutMs || LOCAL_TIMEOUT_MS;
  try {
    return await requestWithRetry(`${LOCAL_BASE}${path}`, {
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body,
      followRedirects: opts.redirect !== "manual",
      timeoutMs,
    });
  } catch (e) {
    if (e instanceof HttpTimeout) throw new ZoteroError(localTimeoutMsg(timeoutMs));
    throw new ZoteroError(localUnreachableMsg());
  }
}

export async function localGET(path, { raw = false, timeoutMs } = {}) {
  const res = await localFetch(path, { timeoutMs });
  if (!res.ok) {
    throw new ZoteroError(`Zotero local API error ${res.status} for ${path}: ${await res.text()}`);
  }
  return raw ? res : res.json();
}

export async function localGETText(path, { timeoutMs } = {}) {
  const res = await localFetch(path, { timeoutMs });
  if (!res.ok) {
    throw new ZoteroError(`Zotero local API error ${res.status} for ${path}`);
  }
  return res.text();
}

// Round-trip time of the cheapest possible local call, for check_status.
export async function pingLocal() {
  const started = Date.now();
  await localGET("/users/0/collections?limit=1", { timeoutMs: Math.min(LOCAL_TIMEOUT_MS, 8000) });
  return Date.now() - started;
}

// ---------- web API ----------

function requireKey() {
  if (!API_KEY) {
    throw new ZoteroError(
      "This operation needs a Zotero API key, and none is configured. Add one in the extension " +
      "settings (Claude Desktop → Settings → Extensions → Zotero Connector). Create a key at " +
      "https://www.zotero.org/settings/keys/new — enable library access, and write access if you " +
      "want Claude to help organize your library."
    );
  }
}

export async function webFetch(path, opts = {}) {
  requireKey();
  const headers = {
    "Zotero-API-Key": API_KEY,
    "Zotero-API-Version": "3",
    ...(opts.headers || {}),
  };
  const timeoutMs = opts.timeoutMs || WEB_TIMEOUT_MS;
  try {
    return await requestWithRetry(`${WEB_BASE}${path}`, {
      method: opts.method || "GET",
      headers,
      body: opts.body,
      timeoutMs,
    });
  } catch (e) {
    if (e instanceof HttpTimeout) {
      throw new ZoteroError(
        `zotero.org did not respond within ${Math.round(timeoutMs / 1000)} seconds. Check your internet ` +
        "connection and try again. If a change was in progress, run list_recent_changes to see what landed."
      );
    }
    throw new ZoteroError(`Could not reach zotero.org (${e.code || e.message}).`);
  }
}

export async function webGET(path) {
  const res = await webFetch(path);
  if (!res.ok) {
    throw new ZoteroError(`Zotero web API error ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json();
}

export async function getUserID() {
  if (cachedUserID) return cachedUserID;
  const info = await webGET("/keys/current");
  cachedUserID = info.userID;
  return cachedUserID;
}

// ---------- libraries ----------

export async function getGroups() {
  if (cachedGroups) return cachedGroups;
  try {
    const groups = await localGET("/users/0/groups");
    cachedGroups = groups.map((g) => ({ id: g.id, name: g.data?.name || g.name || String(g.id) }));
  } catch (e) {
    cachedGroups = [];
  }
  return cachedGroups;
}

// Resolve a library spec ("user" | group name | group id) to prefixes.
export async function resolveLibrary(library) {
  if (!library || library === "user" || library === "personal" || library === "my library") {
    return { kind: "user", localPrefix: "/users/0", label: "My Library" };
  }
  const groups = await getGroups();
  const byId = groups.find((g) => String(g.id) === String(library));
  const byName = groups.find((g) => g.name.toLowerCase() === String(library).toLowerCase());
  const g = byId || byName;
  if (!g) {
    const names = groups.map((g) => g.name).join(", ") || "(no group libraries found)";
    throw new ZoteroError(`Unknown library "${library}". Available group libraries: ${names}. Use "user" for your personal library.`);
  }
  return { kind: "group", groupID: g.id, localPrefix: `/groups/${g.id}`, label: g.name };
}

export async function webPrefix(lib) {
  if (lib.kind === "user") return `/users/${await getUserID()}`;
  return `/groups/${lib.groupID}`;
}

// ---------- collections ----------

export async function getAllCollections(lib) {
  const cols = await localGET(`${lib.localPrefix}/collections`);
  return cols.map((c) => ({
    key: c.key,
    name: c.data.name,
    parent: c.data.parentCollection || null,
    numItems: c.meta?.numItems,
  }));
}

export function buildCollectionTree(cols) {
  const byKey = new Map(cols.map((c) => [c.key, { ...c, children: [] }]));
  const roots = [];
  for (const c of byKey.values()) {
    if (c.parent && byKey.has(c.parent)) byKey.get(c.parent).children.push(c);
    else roots.push(c);
  }
  const sortRec = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

export function collectionPath(col, byKey) {
  const parts = [col.name];
  let cur = col;
  while (cur.parent && byKey.has(cur.parent)) {
    cur = byKey.get(cur.parent);
    parts.unshift(cur.name);
  }
  return parts.join("/");
}

// Resolve a collection by key, name, or "Parent/Child" path (case-insensitive).
export async function resolveCollection(lib, nameOrKey) {
  const cols = await getAllCollections(lib);
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const exactKey = cols.find((c) => c.key === nameOrKey);
  if (exactKey) return { ...exactKey, path: collectionPath(exactKey, byKey) };
  const target = String(nameOrKey).toLowerCase();
  const matches = cols.filter((c) => {
    const p = collectionPath(c, byKey).toLowerCase();
    return c.name.toLowerCase() === target || p === target || p.endsWith(`/${target}`);
  });
  if (matches.length === 1) {
    return { ...matches[0], path: collectionPath(matches[0], byKey) };
  }
  if (matches.length > 1) {
    const paths = matches.map((m) => collectionPath(m, byKey)).join(" | ");
    throw new ZoteroError(`Multiple collections match "${nameOrKey}": ${paths}. Use the full path or the collection key.`);
  }
  const all = cols.map((c) => collectionPath(c, byKey)).sort().join(", ");
  throw new ZoteroError(`No collection named "${nameOrKey}" in ${lib.label}. Available: ${all || "(none)"}`);
}

// ---------- items ----------

export function condenseItem(raw, { withAbstract = true } = {}) {
  const d = raw.data || {};
  const creators = (d.creators || [])
    .map((c) => (c.lastName ? `${c.lastName}${c.firstName ? ", " + c.firstName[0] + "." : ""}` : c.name))
    .filter(Boolean);
  const year = (d.date || "").match(/\d{4}/)?.[0] || "";
  const out = {
    key: raw.key,
    itemType: d.itemType,
    title: d.title || d.nameOfAct || d.caseName || "(untitled)",
    creators,
    year,
    publication: d.publicationTitle || d.bookTitle || d.proceedingsTitle || d.university || d.publisher || undefined,
    DOI: d.DOI || undefined,
    url: d.url || undefined,
    tags: (d.tags || []).map((t) => t.tag),
    collections: d.collections || [],
    dateAdded: d.dateAdded,
  };
  if (withAbstract) out.abstract = d.abstractNote || "";
  return out;
}

const REGULAR_ITEMS_FILTER = "&itemType=-attachment%20%7C%7C%20note%20%7C%7C%20annotation";

export async function getCollectionItems(lib, colKey, { withAbstracts = true } = {}) {
  const items = await localGET(
    `${lib.localPrefix}/collections/${colKey}/items/top?format=json&limit=100000`,
    { timeoutMs: SLOW_TIMEOUT_MS }
  );
  return items
    .filter((i) => !["attachment", "note", "annotation"].includes(i.data?.itemType))
    .map((i) => condenseItem(i, { withAbstract: withAbstracts }));
}

export async function searchItems(lib, { q, qmode = "titleCreatorYear", tag, limit = 50 }) {
  const params = new URLSearchParams({ q: q || "", qmode, format: "json", limit: String(limit) });
  if (tag) params.set("tag", tag);
  const items = await localGET(`${lib.localPrefix}/items/top?${params}`);
  return items
    .filter((i) => !["attachment", "note", "annotation"].includes(i.data?.itemType))
    .map((i) => condenseItem(i));
}

export async function getItem(lib, itemKey) {
  return localGET(`${lib.localPrefix}/items/${itemKey}`);
}

export async function getChildren(lib, itemKey) {
  try {
    return await localGET(`${lib.localPrefix}/items/${itemKey}/children`);
  } catch (e) {
    return [];
  }
}

// Resolve an item by key or (fuzzy) title within a library.
export async function resolveItem(lib, keyOrTitle) {
  if (/^[A-Z0-9]{8}$/.test(keyOrTitle)) {
    try {
      return await getItem(lib, keyOrTitle);
    } catch (e) {
      /* fall through to title search */
    }
  }
  const params = new URLSearchParams({ q: keyOrTitle, qmode: "titleCreatorYear", format: "json", limit: "5" });
  const items = (await localGET(`${lib.localPrefix}/items/top?${params}`)).filter(
    (i) => !["attachment", "note", "annotation"].includes(i.data?.itemType)
  );
  if (items.length === 0) throw new ZoteroError(`No item matching "${keyOrTitle}" found in ${lib.label}.`);
  return items[0];
}

// ---------- full text & files ----------

export async function getPdfAttachments(lib, itemKey) {
  const item = await getItem(lib, itemKey);
  if (item.data.itemType === "attachment") return [item];
  const children = await getChildren(lib, itemKey);
  const atts = children.filter((c) => c.data.itemType === "attachment");
  const pdfs = atts.filter((a) => a.data.contentType === "application/pdf");
  return pdfs.length ? pdfs : atts;
}

export async function getFullText(lib, itemKey) {
  // Try the item itself, then its attachments.
  const tryKeys = [itemKey];
  let atts = [];
  try {
    atts = await getPdfAttachments(lib, itemKey);
    for (const a of atts) if (a.key !== itemKey) tryKeys.push(a.key);
  } catch (e) {
    /* ignore */
  }
  for (const key of tryKeys) {
    try {
      const ft = await localGET(`${lib.localPrefix}/items/${key}/fulltext`, { timeoutMs: SLOW_TIMEOUT_MS });
      if (ft && ft.content) return { key, ...ft };
    } catch (e) {
      /* try next */
    }
  }
  return null;
}

export async function getFilePath(lib, attachmentKey) {
  // The local API redirects /file to a file:/// URL.
  const res = await localFetch(`${lib.localPrefix}/items/${attachmentKey}/file`, {
    redirect: "manual",
  });
  const loc = res.headers.get("location");
  if (loc && loc.startsWith("file://")) {
    return decodeURIComponent(loc.replace(/^file:\/\/(localhost)?/, ""));
  }
  // Some setups may store the path on the attachment record.
  try {
    const att = await getItem(lib, attachmentKey);
    if (att.data.path) return att.data.path.replace(/^attachments:/, "");
  } catch (e) {
    /* ignore */
  }
  return null;
}

// ---------- bibliography / export ----------

async function exportLocalThenWeb(lib, pathAfterPrefix, params) {
  const qs = params.toString();
  try {
    return await localGETText(`${lib.localPrefix}${pathAfterPrefix}?${qs}`, { timeoutMs: SLOW_TIMEOUT_MS });
  } catch (e) {
    // Fall back to the web API (requires key + synced data).
    const prefix = await webPrefix(lib);
    const res = await webFetch(`${prefix}${pathAfterPrefix}?${qs}`, { timeoutMs: SLOW_TIMEOUT_MS });
    if (!res.ok) {
      throw new ZoteroError(
        `Could not export (local API: ${e.message}; web API: ${res.status} ${await res.text()})`
      );
    }
    return res.text();
  }
}

export async function exportBibtex(lib, { collectionKey, itemKeys }) {
  const params = new URLSearchParams({ format: "bibtex", limit: "100000" });
  if (itemKeys?.length) {
    params.set("itemKey", itemKeys.join(","));
    return exportLocalThenWeb(lib, `/items`, params);
  }
  return exportLocalThenWeb(lib, `/collections/${collectionKey}/items/top`, params);
}

export async function exportStyled(lib, { collectionKey, itemKeys, style = "apa" }) {
  const params = new URLSearchParams({ format: "bib", style, limit: "100000" });
  if (itemKeys?.length) {
    params.set("itemKey", itemKeys.join(","));
    return exportLocalThenWeb(lib, `/items`, params);
  }
  return exportLocalThenWeb(lib, `/collections/${collectionKey}/items/top`, params);
}

// ---------- writes (web API) ----------

export async function webGetItemForWrite(lib, itemKey) {
  const prefix = await webPrefix(lib);
  return webGET(`${prefix}/items/${itemKey}`);
}

export async function webPatchItem(lib, itemKey, version, patch) {
  const prefix = await webPrefix(lib);
  const res = await webFetch(`${prefix}/items/${itemKey}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "If-Unmodified-Since-Version": String(version) },
    body: JSON.stringify(patch),
  });
  if (res.status === 412) {
    throw new ZoteroError(
      `Item ${itemKey} changed on the server while editing (version conflict). Sync Zotero and try again.`
    );
  }
  if (!res.ok && res.status !== 204) {
    throw new ZoteroError(`Write failed for item ${itemKey}: ${res.status} ${await res.text()}`);
  }
}

export async function webCreateCollection(lib, name, parentKey) {
  const prefix = await webPrefix(lib);
  const body = [{ name, parentCollection: parentKey || false }];
  const res = await webFetch(`${prefix}/collections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ZoteroError(`Could not create collection: ${res.status} ${await res.text()}`);
  const out = await res.json();
  const created = out.successful?.["0"];
  if (!created) throw new ZoteroError(`Could not create collection: ${JSON.stringify(out.failed || out)}`);
  return created; // {key, version, data}
}

export async function webDeleteCollection(lib, collectionKey) {
  const prefix = await webPrefix(lib);
  const col = await webGET(`${prefix}/collections/${collectionKey}`);
  const res = await webFetch(`${prefix}/collections/${collectionKey}`, {
    method: "DELETE",
    headers: { "If-Unmodified-Since-Version": String(col.version) },
  });
  if (!res.ok && res.status !== 204) {
    throw new ZoteroError(`Could not delete collection: ${res.status} ${await res.text()}`);
  }
}

export async function webItemsWithTag(lib, tag) {
  const prefix = await webPrefix(lib);
  const params = new URLSearchParams({ tag, format: "json", limit: "100" });
  let items = [];
  let start = 0;
  for (;;) {
    params.set("start", String(start));
    const res = await webFetch(`${prefix}/items?${params}`);
    if (!res.ok) throw new ZoteroError(`Tag lookup failed: ${res.status}`);
    const page = await res.json();
    items = items.concat(page);
    if (page.length < 100) break;
    start += 100;
  }
  return items;
}

// ---------- deletion support ----------

// Every top-level member of a collection, including standalone notes, as bare keys.
// Captured before a collection is deleted so undo can recreate the folder and refile it.
export async function getCollectionItemKeys(lib, colKey) {
  const items = await localGET(
    `${lib.localPrefix}/collections/${colKey}/items/top?format=json&limit=100000`,
    { timeoutMs: SLOW_TIMEOUT_MS }
  );
  return items.map((i) => i.key);
}

// A collection plus every collection beneath it, deepest first, each with the details
// needed to rebuild it: name, parent, and members.
export async function collectionSubtree(lib, rootKey) {
  const cols = await getAllCollections(lib);
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const childrenOf = new Map();
  for (const c of cols) {
    if (!childrenOf.has(c.parent)) childrenOf.set(c.parent, []);
    childrenOf.get(c.parent).push(c);
  }
  const ordered = [];
  const walk = (key, depth) => {
    const col = byKey.get(key);
    if (!col) return;
    ordered.push({ key: col.key, name: col.name, parent: col.parent, depth, path: collectionPath(col, byKey) });
    for (const child of childrenOf.get(key) || []) walk(child.key, depth + 1);
  };
  walk(rootKey, 0);
  // Deepest first, so a delete pass never orphans a child and a restore pass can be reversed.
  ordered.sort((a, b) => b.depth - a.depth);
  for (const c of ordered) c.itemKeys = await getCollectionItemKeys(lib, c.key);
  return ordered;
}

// True if the item is already in Zotero's trash.
export async function webIsTrashed(lib, itemKey) {
  const it = await webGetItemForWrite(lib, itemKey);
  return { version: it.version, trashed: it.data.deleted === 1 || it.data.deleted === true, title: it.data.title };
}
