// identifiers.js — turn a DOI, arXiv ID, ISBN, or URL into a Zotero item.
//
// Zotero's own browser button works because Zotero ships hundreds of site-specific translators.
// This has none of those. Instead it uses public metadata services, which are excellent for
// registered identifiers and merely adequate for arbitrary web pages:
//
//   DOI    doi.org content negotiation, which returns CSL-JSON from whichever agency registered
//          the DOI (Crossref, DataCite, mEDRA...). One endpoint, uniform output.
//   arXiv  the arXiv Atom API. If the preprint reports a published DOI, that DOI wins, since the
//          version of record has better metadata than the preprint record.
//   ISBN   Open Library, falling back to Google Books.
//   URL    Highwire (`citation_*`), Dublin Core, and Open Graph <meta> tags. Publishers and
//          preprint servers emit these; blogs and JavaScript-rendered pages generally do not.
//          A page carrying a `citation_doi` is re-routed through the DOI path.

import { requestWithRetry } from "./http.js";

const UA = "zotero-claude-connector (+https://github.com/merylye/zotero-claude-connector)";

// Overridable so the test suite can point them at a mock. Defaults are the real services.
const DOI_BASE = process.env.DOI_RESOLVER_BASE || "https://doi.org";
const ARXIV_BASE = process.env.ARXIV_API_BASE || "https://export.arxiv.org/api/query";
const OPENLIBRARY_BASE = process.env.OPENLIBRARY_BASE || "https://openlibrary.org";
const GOOGLE_BOOKS_BASE = process.env.GOOGLE_BOOKS_BASE || "https://www.googleapis.com";
const LOOKUP_TIMEOUT_MS = 20000;
const MAX_PAGE_BYTES = 2_000_000;

export class LookupError extends Error {}

async function get(url, { accept, maxBytes } = {}) {
  const res = await requestWithRetry(url, {
    headers: { "User-Agent": UA, ...(accept ? { Accept: accept } : {}) },
    timeoutMs: LOOKUP_TIMEOUT_MS,
    maxBytes: maxBytes || 0,
  });
  return res;
}

// ---------------------------------------------------------------- classification

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;
const ARXIV_NEW_RE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;
const ARXIV_OLD_RE = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/;

export function classify(raw) {
  const s = String(raw).trim();

  if (/^(arxiv:)/i.test(s) || /arxiv\.org\/(abs|pdf)\//i.test(s)) {
    const m = s.match(ARXIV_NEW_RE) || s.match(ARXIV_OLD_RE);
    if (m) return { kind: "arxiv", value: m[1] };
  }

  if (/^(doi:)/i.test(s) || /(dx\.)?doi\.org\//i.test(s) || /^10\.\d{4,9}\//.test(s)) {
    const m = s.match(DOI_RE);
    if (m) return { kind: "doi", value: m[1].replace(/[.,;)]+$/, "") };
  }

  const isbnCandidate = s.replace(/^isbn[:\s-]*/i, "").replace(/[\s-]/g, "");
  if (/^\d{9}[\dXx]$/.test(isbnCandidate) || /^\d{13}$/.test(isbnCandidate)) {
    return { kind: "isbn", value: isbnCandidate.toUpperCase() };
  }

  if (/^https?:\/\//i.test(s)) return { kind: "url", value: s };

  // Bare identifiers with no scheme or prefix.
  if (/^10\.\d{4,9}\//.test(s)) return { kind: "doi", value: s };
  const bareArxiv = s.match(/^(\d{4}\.\d{4,5})(v\d+)?$/) || s.match(/^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/);
  if (bareArxiv) return { kind: "arxiv", value: bareArxiv[1] };

  throw new LookupError(
    `Could not tell what "${raw}" is. Give a DOI (10.xxxx/yyyy), an arXiv ID (2303.08774), an ISBN, or a full URL.`
  );
}

// ---------------------------------------------------------------- lookups

export async function lookupDOI(doi) {
  const res = await get(`${DOI_BASE}/${encodeURI(doi)}`, {
    accept: "application/vnd.citationstyles.csl+json",
  });
  if (res.status === 404) throw new LookupError(`No record found for DOI ${doi}. Check it for typos.`);
  if (!res.ok) throw new LookupError(`DOI lookup failed for ${doi} (HTTP ${res.status}).`);
  let csl;
  try {
    csl = await res.json();
  } catch (e) {
    throw new LookupError(`DOI ${doi} resolved, but the metadata was not readable CSL-JSON.`);
  }
  csl.DOI = csl.DOI || doi;
  return { csl, source: "doi.org content negotiation" };
}

function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

export async function lookupArxiv(id) {
  const res = await get(`${ARXIV_BASE}?id_list=${encodeURIComponent(id)}&max_results=1`);
  if (!res.ok) throw new LookupError(`arXiv lookup failed for ${id} (HTTP ${res.status}).`);
  const xml = await res.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) throw new LookupError(`No arXiv record found for ${id}.`);

  // A published paper's version of record beats its preprint record.
  const doi = xmlField(entry, "arxiv:doi");
  if (doi) {
    try {
      const viaDoi = await lookupDOI(doi);
      viaDoi.source = `arXiv ${id}, resolved to its published DOI ${doi}`;
      return viaDoi;
    } catch (e) {
      // Fall through to the preprint record.
    }
  }

  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) =>
    m[1].replace(/\s+/g, " ").trim()
  );
  const published = xmlField(entry, "published") || "";
  const csl = {
    type: "article",
    title: xmlField(entry, "title"),
    abstract: xmlField(entry, "summary"),
    author: authors.map((name) => ({ literal: name })),
    issued: { "date-parts": [published.slice(0, 10).split("-").map(Number).filter(Boolean)] },
    URL: `https://arxiv.org/abs/${id}`,
    number: id,
    publisher: "arXiv",
    _preprint: true,
  };
  return { csl, source: `arXiv API (${id})` };
}

export async function lookupISBN(isbn) {
  const ol = await get(`${OPENLIBRARY_BASE}/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  if (ol.ok) {
    const data = await ol.json();
    const rec = data?.[`ISBN:${isbn}`];
    if (rec) {
      return {
        csl: {
          type: "book",
          title: rec.title + (rec.subtitle ? `: ${rec.subtitle}` : ""),
          author: (rec.authors || []).map((a) => ({ literal: a.name })),
          issued: { "date-parts": [[parseInt(String(rec.publish_date).match(/\d{4}/)?.[0], 10)].filter(Boolean)] },
          publisher: (rec.publishers || [])[0]?.name,
          "publisher-place": (rec.publish_places || [])[0]?.name,
          "number-of-pages": rec.number_of_pages,
          ISBN: isbn,
          URL: rec.url,
        },
        source: "Open Library",
      };
    }
  }
  const gb = await get(`${GOOGLE_BOOKS_BASE}/books/v1/volumes?q=isbn:${isbn}`);
  if (gb.ok) {
    const data = await gb.json();
    const v = data?.items?.[0]?.volumeInfo;
    if (v) {
      return {
        csl: {
          type: "book",
          title: v.title + (v.subtitle ? `: ${v.subtitle}` : ""),
          author: (v.authors || []).map((a) => ({ literal: a })),
          issued: { "date-parts": [[parseInt(String(v.publishedDate).match(/\d{4}/)?.[0], 10)].filter(Boolean)] },
          publisher: v.publisher,
          "number-of-pages": v.pageCount,
          abstract: v.description,
          ISBN: isbn,
        },
        source: "Google Books",
      };
    }
  }
  throw new LookupError(`No book found for ISBN ${isbn} in Open Library or Google Books.`);
}

function metaTags(html) {
  const tags = {};
  const re = /<meta\s+([^>]+?)\/?>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const key = attrs.match(/(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
    const val = attrs.match(/content\s*=\s*["']([\s\S]*?)["']/i)?.[1];
    if (!key || val == null) continue;
    const k = key.toLowerCase();
    if (!tags[k]) tags[k] = [];
    tags[k].push(decodeEntities(val.trim()));
  }
  return tags;
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", hellip: "\u2026", times: "\u00d7",
};

// Crossref and publisher pages both hand back entity-encoded text, so "AI &amp; SOCIETY" arrives
// where "AI & SOCIETY" belongs. Every string that reaches Zotero goes through this.
function decodeEntities(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(n) {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch (e) {
    return "";
  }
}

export async function lookupURL(url) {
  const res = await get(url, { accept: "text/html,application/xhtml+xml", maxBytes: MAX_PAGE_BYTES });
  if (!res.ok) throw new LookupError(`Could not fetch ${url} (HTTP ${res.status}).`);
  const html = await res.text();
  const t = metaTags(html);
  const one = (...keys) => {
    for (const k of keys) if (t[k]?.length) return t[k][0];
    return undefined;
  };
  const many = (...keys) => {
    for (const k of keys) if (t[k]?.length) return t[k];
    return [];
  };

  // A page that declares its own DOI has a better record elsewhere.
  const doi = one("citation_doi", "dc.identifier.doi");
  if (doi && DOI_RE.test(doi)) {
    try {
      const viaDoi = await lookupDOI(doi.match(DOI_RE)[1]);
      viaDoi.source = `${url}, resolved via its citation_doi ${doi}`;
      return viaDoi;
    } catch (e) {
      // Fall through to the page's own tags.
    }
  }

  const title = one("citation_title", "dc.title", "og:title", "twitter:title") || pageTitle(html);
  if (!title) {
    throw new LookupError(
      `${url} carries no citation metadata that could be read. Save it with Zotero's browser button instead, ` +
        "which has a translator for the site, or create the item by hand."
    );
  }
  const journal = one("citation_journal_title", "citation_conference_title", "citation_inbook_title", "og:site_name");
  const date = one("citation_publication_date", "citation_date", "citation_online_date", "dc.date", "article:published_time");
  const authors = many("citation_author", "dc.creator", "author");

  const isConference = !!one("citation_conference_title");
  const csl = {
    type: journal ? (isConference ? "paper-conference" : "article-journal") : "webpage",
    title,
    "container-title": journal,
    author: authors.map((a) => parseNameString(a)),
    issued: date ? { "date-parts": [String(date).split(/[-/]/).map(Number).filter(Boolean)] } : undefined,
    abstract: one("citation_abstract", "dc.description", "og:description", "description"),
    volume: one("citation_volume"),
    issue: one("citation_issue"),
    page: joinPages(one("citation_firstpage"), one("citation_lastpage")),
    publisher: one("citation_publisher", "dc.publisher"),
    ISSN: one("citation_issn"),
    ISBN: one("citation_isbn"),
    URL: one("citation_public_url", "og:url") || url,
    language: one("citation_language", "dc.language"),
    _accessed: true,
  };
  return { csl, source: `meta tags on ${url}${res.truncated ? " (page truncated during fetch)" : ""}` };
}

function pageTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : null;
}

function joinPages(first, last) {
  if (!first) return undefined;
  return last && last !== first ? `${first}-${last}` : first;
}

// "Lakoff, George" and "George Lakoff" both occur in the wild.
function parseNameString(s) {
  const str = String(s).trim();
  if (str.includes(",")) {
    const [family, given] = str.split(",", 2);
    return { family: family.trim(), given: (given || "").trim() };
  }
  const parts = str.split(/\s+/);
  if (parts.length === 1) return { literal: str };
  return { family: parts.pop(), given: parts.join(" ") };
}

export async function lookup(raw) {
  const id = classify(raw);
  switch (id.kind) {
    case "doi":
      return { ...(await lookupDOI(id.value)), identifier: id };
    case "arxiv":
      return { ...(await lookupArxiv(id.value)), identifier: id };
    case "isbn":
      return { ...(await lookupISBN(id.value)), identifier: id };
    case "url":
      return { ...(await lookupURL(id.value)), identifier: id };
    default:
      throw new LookupError(`Unsupported identifier kind ${id.kind}.`);
  }
}

// ---------------------------------------------------------------- CSL → Zotero

// Two vocabularies land here. Strict CSL types ("article-journal") come from DataCite and from our
// own synthesised records; Crossref's CSL transform emits Crossref's type names instead
// ("journal-article", "proceedings-article", "monograph"). Both are mapped, because in practice a
// DOI can return either.
const TYPE_MAP = {
  // CSL
  "article-journal": "journalArticle",
  article: "journalArticle",
  "paper-conference": "conferencePaper",
  chapter: "bookSection",
  book: "book",
  // Crossref
  "journal-article": "journalArticle",
  "journal-issue": "journalArticle",
  "journal-volume": "journalArticle",
  journal: "journalArticle",
  "proceedings-article": "conferencePaper",
  proceedings: "book",
  "proceedings-series": "book",
  "book-chapter": "bookSection",
  "book-part": "bookSection",
  "book-section": "bookSection",
  "book-track": "bookSection",
  "book-series": "book",
  "book-set": "book",
  monograph: "book",
  "edited-book": "book",
  "reference-book": "book",
  "reference-entry": "dictionaryEntry",
  dissertation: "thesis",
  "report-component": "report",
  "peer-review": "document",
  component: "document",
  grant: "document",
  other: "document",
  thesis: "thesis",
  report: "report",
  dataset: "dataset",
  "posted-content": "preprint",
  preprint: "preprint",
  manuscript: "manuscript",
  webpage: "webpage",
  document: "document",
  "article-newspaper": "newspaperArticle",
  "article-magazine": "magazineArticle",
  speech: "presentation",
  patent: "patent",
  software: "computerProgram",
  map: "map",
  "motion_picture": "film",
  broadcast: "tvBroadcast",
  interview: "interview",
  "personal_communication": "letter",
  "entry-encyclopedia": "encyclopediaArticle",
  entry: "dictionaryEntry",
  "legal_case": "case",
  bill: "bill",
};

export function zoteroTypeFor(csl) {
  if (csl._preprint) return "preprint";
  return TYPE_MAP[csl.type] || "journalArticle";
}

// Zotero names the "what contains this" field differently per item type, and the set has changed
// across Zotero versions. Rather than hardcode a table that rots, ask the item template which of
// these it actually has.
const CONTAINER_FIELDS = [
  "publicationTitle", "proceedingsTitle", "bookTitle", "encyclopediaTitle", "dictionaryTitle",
  "websiteTitle", "blogTitle", "forumTitle", "programTitle", "repository", "seriesTitle",
];
const PUBLISHER_FIELDS = ["publisher", "institution", "university", "company", "label", "distributor", "repository"];

function pick(template, candidates) {
  for (const f of candidates) if (f in template) return f;
  return null;
}

// Crossref returns abstracts as JATS XML, complete with namespaced tags and the indentation of the
// deposited record. Zotero wants plain text.
function plainText(v) {
  if (v == null) return "";
  return decodeEntities(
    String(v)
      .replace(/<\/(p|jats:p|sec|jats:sec|title|jats:title)>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A few CSL fields are string-or-array depending on the source.
function first(v) {
  if (Array.isArray(v)) return v.length ? v[0] : undefined;
  return v;
}

function cslDate(csl) {
  const d = csl.issued || csl["available-date"];
  if (!d) return "";
  if (d.raw) return String(d.raw);
  const parts = (d["date-parts"] || [])[0] || [];
  const [y, m, day] = parts;
  if (!y) return "";
  if (!m) return String(y);
  const mm = String(m).padStart(2, "0");
  return day ? `${y}-${mm}-${String(day).padStart(2, "0")}` : `${y}-${mm}`;
}

function creators(csl, validTypes) {
  const out = [];
  const add = (list, type) => {
    if (!validTypes.includes(type)) type = validTypes[0];
    for (const c of list || []) {
      if (c.literal || (!c.family && !c.given)) {
        const name = c.literal || [c.given, c.family].filter(Boolean).join(" ");
        if (name) out.push({ creatorType: type, name });
      } else {
        out.push({ creatorType: type, firstName: c.given || "", lastName: c.family || "" });
      }
    }
  };
  add(csl.author, "author");
  add(csl.editor, "editor");
  add(csl.translator, "translator");
  add(csl["container-author"], "bookAuthor");
  return out;
}

/**
 * Build a Zotero item from CSL-JSON, using the item template to decide which fields exist.
 * Anything meaningful that the type has no home for goes into `extra`, which is where Zotero
 * users put it by hand anyway.
 */
export function cslToZotero(csl, template, { creatorTypes = ["author"] } = {}) {
  const item = { itemType: template.itemType };
  const set = (field, value) => {
    if (!field || value == null || value === "" || !(field in template)) return;
    // Titles and container titles carry markup as well as entities; other fields carry entities.
    const clean = /title|Title|abstractNote|conferenceName/.test(field)
      ? plainText(value)
      : decodeEntities(String(value)).trim();
    if (clean) item[field] = clean;
  };

  const subtitle = first(csl.subtitle);
  const mainTitle = first(csl.title) || first(csl["container-title"]);
  set("title", subtitle && !String(mainTitle).includes(subtitle) ? `${mainTitle}: ${subtitle}` : mainTitle);
  set(pick(template, CONTAINER_FIELDS), first(csl["container-title"]));
  set("conferenceName", first(csl.event) || first(csl["event-title"]));
  set("date", cslDate(csl));
  set("volume", csl.volume);
  set("issue", csl.issue);
  set("pages", csl.page);
  set("abstractNote", plainText(csl.abstract));
  set("language", csl.language);
  set("DOI", csl.DOI);
  set("ISSN", first(csl.ISSN));
  set("ISBN", first(csl.ISBN));
  // Crossref returns the legacy http://dx.doi.org form; the canonical one is nicer to click.
  set("url", first(csl.URL)?.replace(/^http:\/\/(dx\.)?doi\.org\//i, "https://doi.org/"));
  set("edition", csl.edition);
  set("numPages", csl["number-of-pages"]);
  set("series", csl["collection-title"]);
  set("seriesNumber", csl["collection-number"]);
  set("reportNumber", csl.number);
  set("archiveID", csl.number);
  // Preprint servers put their name in `institution` rather than `publisher`.
  const publisher = first(csl.publisher) || first(csl.institution)?.name || first(csl.institution);
  set(pick(template, PUBLISHER_FIELDS), publisher);
  // Crossref says publisher-location; strict CSL says publisher-place.
  set("place", first(csl["publisher-place"]) || first(csl["publisher-location"]));
  if ("accessDate" in template && (csl._accessed || template.itemType === "webpage")) {
    item.accessDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  const cs = creators(csl, creatorTypes);
  if (cs.length && "creators" in template) item.creators = cs;

  const extra = [];
  if (csl.DOI && !("DOI" in template)) extra.push(`DOI: ${csl.DOI}`);
  if (csl.PMID) extra.push(`PMID: ${csl.PMID}`);
  if (extra.length && "extra" in template) item.extra = extra.join("\n");

  return item;
}
