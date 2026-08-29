// Mock Zotero local API (port 23119) + web API (port 8123) for end-to-end testing.
import http from "node:http";

// ---------------- in-memory library ----------------
export const state = {
  collections: {
    AAAA1111: { key: "AAAA1111", version: 1, data: { name: "Metaphor Study", parentCollection: false }, meta: { numItems: 2 } },
    BBBB2222: { key: "BBBB2222", version: 1, data: { name: "Methods", parentCollection: "AAAA1111" }, meta: { numItems: 1 } },
    CCCC3333: { key: "CCCC3333", version: 1, data: { name: "Unsorted", parentCollection: false }, meta: { numItems: 1 } },
  },
  items: {
    ITEM0001: {
      key: "ITEM0001", version: 10,
      data: {
        itemType: "journalArticle", title: "Conceptual Metaphor in Everyday Language",
        creators: [{ creatorType: "author", firstName: "George", lastName: "Lakoff" }, { creatorType: "author", firstName: "Mark", lastName: "Johnson" }],
        date: "1980-08-01", publicationTitle: "The Journal of Philosophy", DOI: "10.2307/2025464",
        abstractNote: "We argue that metaphor is pervasive in everyday life, not just in language but in thought and action.",
        tags: [{ tag: "metaphor" }, { tag: "to-read" }], collections: ["AAAA1111"], dateAdded: "2025-01-15T10:00:00Z",
      },
    },
    ITEM0002: {
      key: "ITEM0002", version: 11,
      data: {
        itemType: "journalArticle", title: "Metaphor Comprehension: A Computational Model",
        creators: [{ creatorType: "author", firstName: "Sam", lastName: "Glucksberg" }],
        date: "2003", publicationTitle: "Cognitive Science",
        abstractNote: "A computational account of how people understand metaphorical statements in real time.",
        tags: [{ tag: "metaphor" }], collections: ["AAAA1111", "BBBB2222"], dateAdded: "2025-02-20T10:00:00Z",
      },
    },
    ITEM0003: {
      key: "ITEM0003", version: 12,
      data: {
        itemType: "conferencePaper", title: "Neural Networks for Figurative Language Detection",
        creators: [{ creatorType: "author", firstName: "Ada", lastName: "Chen" }],
        date: "2022", proceedingsTitle: "Proc. ACL",
        abstractNote: "We present transformer models that detect figurative language across genres.",
        tags: [], collections: ["CCCC3333"], dateAdded: "2025-03-01T10:00:00Z",
      },
    },
    ATT00001: {
      key: "ATT00001", version: 10,
      data: { itemType: "attachment", parentItem: "ITEM0001", contentType: "application/pdf", title: "Lakoff-Johnson-1980.pdf", filename: "Lakoff-Johnson-1980.pdf" },
    },
    NOTE0001: {
      key: "NOTE0001", version: 10,
      data: { itemType: "note", parentItem: "ITEM0001", note: "<p>Key claim: metaphors <b>structure</b> thought.</p><p>Use in ch. 2.</p>", dateModified: "2025-04-01T09:00:00Z" },
    },
    ANN00001: {
      key: "ANN00001", version: 10,
      data: { itemType: "annotation", parentItem: "ATT00001", annotationType: "highlight", annotationText: "Metaphor is pervasive in everyday life", annotationComment: "central thesis", annotationColor: "#ffd400", annotationPageLabel: "3" },
    },
  },
  fulltext: {
    ATT00001: { content: "FULL TEXT START. " + "Metaphor structures human thought. ".repeat(50) + "FULL TEXT END.", indexedPages: 12, totalPages: 12 },
  },
  groups: [{ id: 501, data: { name: "CogSci Lab" }, name: "CogSci Lab" }],
  groupItems: {},
};

function send(res, code, body, headers = {}) {
  const isStr = typeof body === "string";
  res.writeHead(code, { "Content-Type": isStr ? "text/plain" : "application/json", ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

function childrenOf(key) {
  return Object.values(state.items).filter((i) => i.data.parentItem === key);
}

function topItems() {
  // Zotero's local API hides trashed items from normal listings and searches.
  return Object.values(state.items).filter((i) => !i.data.parentItem && i.data.deleted !== 1);
}

function bibtexFor(items) {
  return items
    .map((i) => {
      const last = i.data.creators?.[0]?.lastName || "anon";
      const year = (i.data.date || "").match(/\d{4}/)?.[0] || "n.d.";
      return `@article{${last.toLowerCase()}${year},\n  title={${i.data.title}},\n  year={${year}}\n}`;
    })
    .join("\n\n");
}

function styledFor(items, style) {
  return items.map((i) => `[${style}] ${i.data.creators?.[0]?.lastName} (${(i.data.date || "").match(/\d{4}/)?.[0]}). ${i.data.title}.`).join("\n");
}

function pickItemsFromQuery(url) {
  let items = topItems();
  const q = url.searchParams.get("q");
  const qmode = url.searchParams.get("qmode") || "titleCreatorYear";
  const tag = url.searchParams.get("tag");
  const itemKey = url.searchParams.get("itemKey");
  if (itemKey) items = itemKey.split(",").map((k) => state.items[k]).filter(Boolean);
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter((i) => {
      const inMeta =
        (i.data.title || "").toLowerCase().includes(needle) ||
        (i.data.creators || []).some((c) => (c.lastName || "").toLowerCase().includes(needle));
      if (inMeta) return true;
      if (qmode === "everything") {
        return childrenOf(i.key).some((att) => (state.fulltext[att.key]?.content || "").toLowerCase().includes(needle));
      }
      return false;
    });
  }
  if (tag) items = items.filter((i) => (i.data.tags || []).some((t) => t.tag === tag));
  return items;
}

// ---------------- local API ----------------
export function startLocal(port = 23119) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const format = url.searchParams.get("format");
    const m = (re) => p.match(re);
    let mm;
    if (p === "/api/users/0/groups") return send(res, 200, state.groups);
    if (p === "/api/users/0/collections") return send(res, 200, Object.values(state.collections));
    if ((mm = m(/^\/api\/users\/0\/collections\/(\w+)\/items\/top$/))) {
      const colKey = mm[1];
      let items = topItems().filter((i) => (i.data.collections || []).includes(colKey));
      if (format === "bibtex") return send(res, 200, bibtexFor(items));
      if (format === "bib") return send(res, 501, "Not Implemented"); // force web fallback for styled
      return send(res, 200, items);
    }
    if (p === "/api/users/0/items/top" || p === "/api/users/0/items") {
      const items = pickItemsFromQuery(url);
      if (format === "bibtex") return send(res, 200, bibtexFor(items));
      if (format === "bib") return send(res, 501, "Not Implemented");
      return send(res, 200, p.endsWith("/top") ? items.filter((i) => !i.data.parentItem) : items);
    }
    if ((mm = m(/^\/api\/users\/0\/items\/(\w+)\/children$/))) return send(res, 200, childrenOf(mm[1]));
    if ((mm = m(/^\/api\/users\/0\/items\/(\w+)\/fulltext$/))) {
      const ft = state.fulltext[mm[1]];
      return ft ? send(res, 200, ft) : send(res, 404, "Not found");
    }
    if ((mm = m(/^\/api\/users\/0\/items\/(\w+)\/file$/))) {
      return send(res, 302, "", { Location: "file:///home/testuser/Zotero/storage/ATT00001/Lakoff-Johnson-1980.pdf" });
    }
    if ((mm = m(/^\/api\/users\/0\/items\/(\w+)$/))) {
      const it = state.items[mm[1]];
      return it ? send(res, 200, it) : send(res, 404, "Not found");
    }
    send(res, 404, `mock local: no route ${p}`);
  });
  srv.listen(port);
  return srv;
}

// ---------------- web API ----------------
export function startWeb(port = 8123) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    let body = "";
    for await (const chunk of req) body += chunk;
    const m = (re) => p.match(re);
    let mm;
    if (!req.headers["zotero-api-key"]) return send(res, 403, "Missing key");
    if (p === "/keys/current") return send(res, 200, { userID: 1234, username: "testuser" });
    if ((mm = m(/^\/users\/1234\/items\/(\w+)$/)) && req.method === "GET") {
      const it = state.items[mm[1]];
      return it ? send(res, 200, it) : send(res, 404, "Not found");
    }
    if ((mm = m(/^\/users\/1234\/items\/(\w+)$/)) && req.method === "PATCH") {
      const it = state.items[mm[1]];
      if (!it) return send(res, 404, "Not found");
      const ifV = Number(req.headers["if-unmodified-since-version"]);
      if (ifV !== it.version) return send(res, 412, "Precondition failed");
      Object.assign(it.data, JSON.parse(body));
      it.version++;
      return send(res, 204, "");
    }
    if (p === "/users/1234/items" && req.method === "GET") {
      const items = pickItemsFromQuery(url);
      const format = url.searchParams.get("format");
      if (format === "bib") return send(res, 200, styledFor(items, url.searchParams.get("style") || "apa"));
      if (format === "bibtex") return send(res, 200, bibtexFor(items));
      return send(res, 200, items);
    }
    if (p === "/users/1234/collections" && req.method === "POST") {
      const [c] = JSON.parse(body);
      const key = "NEW" + Math.floor(Math.random() * 90000 + 10000);
      state.collections[key] = { key, version: 1, data: { name: c.name, parentCollection: c.parentCollection || false }, meta: { numItems: 0 } };
      return send(res, 200, { successful: { 0: { key, version: 1, data: state.collections[key].data } }, failed: {} });
    }
    if ((mm = m(/^\/users\/1234\/collections\/(\w+)$/)) && req.method === "GET") {
      const c = state.collections[mm[1]];
      return c ? send(res, 200, c) : send(res, 404, "Not found");
    }
    if ((mm = m(/^\/users\/1234\/collections\/(\w+)$/)) && req.method === "DELETE") {
      delete state.collections[mm[1]];
      return send(res, 204, "");
    }
    if ((mm = m(/^\/users\/1234\/collections\/(\w+)\/items\/top$/))) {
      const colKey = mm[1];
      const items = topItems().filter((i) => (i.data.collections || []).includes(colKey));
      const format = url.searchParams.get("format");
      if (format === "bib") return send(res, 200, styledFor(items, url.searchParams.get("style") || "apa"));
      if (format === "bibtex") return send(res, 200, bibtexFor(items));
      return send(res, 200, items);
    }
    if (p === "/users/1234/items" && url.searchParams.get("format") === "bib") {
      return send(res, 200, styledFor(pickItemsFromQuery(url), url.searchParams.get("style") || "apa"));
    }
    send(res, 404, `mock web: no route ${req.method} ${p}`);
  });
  srv.listen(port);
  return srv;
}

// A server that accepts the connection and then says nothing, ever. Stands in for a Zotero whose
// local API has stopped answering, which is the state that used to hang the connector indefinitely.
export const blackHole = { connections: 0 };
export function startBlackHole(port) {
  const srv = http.createServer(() => {
    blackHole.connections++;
    // Deliberately no response.
  });
  srv.listen(port);
  return srv;
}

if (process.argv[1].endsWith("mock-zotero.js")) {
  startLocal();
  startWeb();
  console.log("mock zotero running: local :23119, web :8123");
}
