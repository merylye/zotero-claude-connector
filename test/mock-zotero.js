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

// Field sets mirroring what api.zotero.org/items/new returns, trimmed to what the mapper uses.
const COMMON = { key: "", version: 0, itemType: "", title: "", creators: [], abstractNote: "", date: "",
  language: "", url: "", accessDate: "", extra: "", tags: [], collections: [], relations: {} };
export const TEMPLATES = {
  journalArticle: { ...COMMON, itemType: "journalArticle", publicationTitle: "", volume: "", issue: "",
    pages: "", series: "", seriesTitle: "", DOI: "", ISSN: "", journalAbbreviation: "" },
  conferencePaper: { ...COMMON, itemType: "conferencePaper", proceedingsTitle: "", conferenceName: "",
    place: "", publisher: "", volume: "", pages: "", series: "", DOI: "", ISBN: "" },
  book: { ...COMMON, itemType: "book", publisher: "", place: "", edition: "", numPages: "", series: "",
    seriesNumber: "", ISBN: "" },
  preprint: { ...COMMON, itemType: "preprint", genre: "", repository: "", archiveID: "", place: "",
    DOI: "", citationKey: "" },
  webpage: { ...COMMON, itemType: "webpage", websiteTitle: "", websiteType: "" },
};
export const CREATOR_TYPES = {
  journalArticle: ["author", "contributor", "editor", "reviewedAuthor", "translator"],
  conferencePaper: ["author", "contributor", "editor", "seriesEditor", "translator"],
  book: ["author", "contributor", "editor", "seriesEditor", "translator"],
  preprint: ["author", "contributor", "editor", "translator"],
  webpage: ["author", "contributor", "translator"],
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
        // Zotero's "Everything" mode searches all item fields as well as indexed full text.
        const inAnyField = Object.entries(i.data).some(
          ([k, v]) => typeof v === "string" && k !== "title" && v.toLowerCase().includes(needle)
        );
        if (inAnyField) return true;
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
    // Item templates, creator types, and the stand-ins for external services are public,
    // exactly as they are on the real api.zotero.org and the real metadata providers.
    const isPublic =
      p.startsWith("/doi/") || p === "/arxiv" || p === "/api/books" || p === "/books/v1/volumes" ||
      p.startsWith("/page/") || p === "/items/new" || p === "/itemTypeCreatorTypes";
    if (!isPublic && !req.headers["zotero-api-key"]) return send(res, 403, "Missing key");
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
    if (p === "/items/new") {
      const t = TEMPLATES[url.searchParams.get("itemType")];
      return t ? send(res, 200, t) : send(res, 400, "Invalid item type");
    }
    if (p === "/itemTypeCreatorTypes") {
      const c = CREATOR_TYPES[url.searchParams.get("itemType")] || [];
      return send(res, 200, c.map((creatorType) => ({ creatorType, localized: creatorType })));
    }
    if (p === "/users/1234/items" && req.method === "POST") {
      const payload = JSON.parse(body);
      const successful = {}, failed = {};
      payload.forEach((it, i) => {
        if (!it.itemType || !it.title) {
          failed[String(i)] = { code: 400, message: "missing itemType or title" };
          return;
        }
        const key = "NEWI" + Math.floor(Math.random() * 9000 + 1000);
        state.items[key] = { key, version: 1, data: { ...it, key, dateAdded: new Date().toISOString() } };
        successful[String(i)] = { key, version: 1, data: state.items[key].data };
      });
      return send(res, 200, { successful, failed, unchanged: {} });
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
    // ---- stand-ins for the external metadata services ----
    if (p.startsWith("/doi/")) {
      const doi = decodeURIComponent(p.slice(5));
      const rec = DOI_RECORDS[doi];
      return rec ? send(res, 200, rec) : send(res, 404, "Not found");
    }
    if (p === "/arxiv") {
      const id = url.searchParams.get("id_list");
      const rec = ARXIV_RECORDS[id];
      return rec ? send(res, 200, rec) : send(res, 200, "<feed></feed>");
    }
    if (p === "/api/books") {
      const bib = url.searchParams.get("bibkeys");
      const rec = ISBN_RECORDS[bib];
      return send(res, 200, rec ? { [bib]: rec } : {});
    }
    if (p === "/books/v1/volumes") return send(res, 200, {});
    if (p === "/page/with-meta") {
      return send(res, 200, PAGE_WITH_META, { "Content-Type": "text/html" });
    }
    if (p === "/page/bare") {
      return send(res, 200, "<html><head><title>Just A Blog Post</title></head><body>hi</body></html>", { "Content-Type": "text/html" });
    }
    send(res, 404, `mock web: no route ${req.method} ${p}`);
  });
  srv.listen(port);
  return srv;
}

// CSL-JSON as doi.org content negotiation returns it.
export const DOI_RECORDS = {
  // Shaped exactly like a live Crossref CSL transform: Crossref's own type vocabulary,
  // publisher-location rather than publisher-place, `event` for the conference name.
  "10.1145/3411764.3445374": {
    DOI: "10.1145/3411764.3445374",
    type: "proceedings-article",
    title: "Designing for Reflection in Collaborative Systems",
    "container-title": "Proceedings of the 2021 CHI Conference on Human Factors in Computing Systems",
    event: "CHI '21: CHI Conference on Human Factors in Computing Systems",
    author: [
      { family: "Okafor", given: "Ada", sequence: "first" },
      { family: "Lindqvist", given: "Bo", sequence: "additional" },
    ],
    issued: { "date-parts": [[2021, 5, 6]] },
    page: "1-14",
    publisher: "ACM",
    "publisher-location": "New York, NY, USA",
    subtitle: [],
    ISBN: ["9781450380966"],
  },
  "10.9999/preprint.2024": {
    DOI: "10.9999/preprint.2024",
    type: "journal-article",
    title: "A Published Version Of The Preprint",
    "container-title": "Science &amp; Society: A Journal &#8212; Test Results",
    author: [{ family: "Rivera", given: "Kim" }],
    issued: { "date-parts": [[2024]] },
    volume: "7",
    issue: "2",
    page: "88-101",
    URL: "http://dx.doi.org/10.9999/preprint.2024",
  },
  // A preprint, as Crossref returns them: posted-content, an empty container-title array,
  // the server named in `institution`, and a JATS-XML abstract.
  "10.1101/2020.03.20.000133": {
    DOI: "10.1101/2020.03.20.000133",
    type: "posted-content",
    title: "Deep Learning For Bioimaging Without The Barriers",
    "container-title": [],
    institution: [{ name: "bioRxiv" }],
    author: [{ family: "Nguyen", given: "Thi" }],
    issued: { "date-parts": [[2020, 3, 20]] },
    abstract:
      "<jats:p>\n   The resources and expertise needed to use Deep Learning remain <jats:italic>significant</jats:italic> barriers.\n   </jats:p>",
  },
  // A book, where Crossref says monograph and the ISBN is an array.
  "10.1017/CBO9780511815355": {
    DOI: "10.1017/CBO9780511815355",
    type: "monograph",
    title: "A Monograph About Method",
    "container-title": [],
    author: [{ family: "Ashby", given: "Ruth" }],
    issued: { "date-parts": [[2011]] },
    publisher: "Cambridge University Press",
    "publisher-place": "Cambridge",
    ISBN: ["9780511815355", "9780521193467"],
  },
};

export const ARXIV_RECORDS = {
  "2303.08774": `<feed><entry>
    <title>Transformers For Everything</title>
    <summary>A sweeping and slightly overconfident survey.</summary>
    <published>2023-03-15T00:00:00Z</published>
    <author><name>Dana Q. Fletcher</name></author>
    <author><name>Wei Zhang</name></author>
  </entry></feed>`,
  "2401.00001": `<feed><entry>
    <title>The Preprint That Got Published</title>
    <summary>Superseded by the journal version.</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>Kim Rivera</name></author>
    <arxiv:doi>10.9999/preprint.2024</arxiv:doi>
  </entry></feed>`,
};

export const ISBN_RECORDS = {
  "ISBN:9780226468013": {
    title: "Metaphors We Live By",
    authors: [{ name: "George Lakoff" }, { name: "Mark Johnson" }],
    publish_date: "1980",
    publishers: [{ name: "University of Chicago Press" }],
    publish_places: [{ name: "Chicago" }],
    number_of_pages: 242,
  },
};

export const PAGE_WITH_META = `<html><head>
  <title>Publisher page</title>
  <meta name="citation_title" content="Situated Knowledge In Practice">
  <meta name="citation_author" content="Haraway, Donna">
  <meta name="citation_author" content="Chen, Li">
  <meta name="citation_journal_title" content="Studies in Method">
  <meta name="citation_publication_date" content="2019/07/01">
  <meta name="citation_volume" content="12">
  <meta name="citation_issue" content="3">
  <meta name="citation_firstpage" content="200">
  <meta name="citation_lastpage" content="219">
  <meta name="citation_issn" content="1234-5678">
  <meta name="citation_publisher" content="Method Press">
  <meta name="dc.description" content="An abstract about situated knowledge.">
</head><body>body text</body></html>`;

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
