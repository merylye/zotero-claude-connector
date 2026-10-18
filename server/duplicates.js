// duplicates.js — finding probable duplicates and choosing which copy to keep.
//
// Two items are grouped when they share a DOI, or when their titles match after normalisation.
// Matching is transitive: if A shares a DOI with B and B shares a title with C, all three form one
// group. The scan is deliberately conservative about titles, because a false match that gets merged
// hides a real paper in the trash (recoverable, but surprising).

const PUBLISHED_TYPES = new Set([
  "journalArticle",
  "conferencePaper",
  "book",
  "bookSection",
  "thesis",
  "report",
  "magazineArticle",
  "newspaperArticle",
]);
const WEAK_TYPES = new Set(["webpage", "blogPost", "forumPost", "document"]);

// Bare, lowercase DOI from any of the forms people and translators store.
export function normaliseDOI(s) {
  if (!s) return null;
  const m = String(s).match(/10\.\d{4,9}\/[^\s"<>]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;)\]]+$/, "").toLowerCase();
}

// DOI from the DOI field, a "DOI: ..." line in Extra, or a doi.org URL.
export function itemDOI(data) {
  const fromField = normaliseDOI(data.DOI);
  if (fromField) return fromField;
  const extraLine = (data.extra || "").split("\n").find((l) => /^\s*doi\s*:/i.test(l));
  if (extraLine) {
    const d = normaliseDOI(extraLine);
    if (d) return d;
  }
  if (/doi\.org\//i.test(data.url || "")) return normaliseDOI(data.url);
  return null;
}

// Titles saved from a publisher page often carry the site after a separator:
// "Paper Title | Proceedings of the 2026 ACM Conference ...". Strip that, then fold case and
// punctuation so "Towards a model" and "Towards a Model." compare equal.
export function normaliseTitle(title, itemType) {
  let t = String(title || "");
  if (WEAK_TYPES.has(itemType)) t = t.split(/\s[|–—]\s|\s-\s/)[0];
  return t
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Short titles ("Introduction", "Motivational Interviewing") collide across unrelated works.
function titleIsDistinctive(norm) {
  return norm.length >= 25 && norm.split(" ").length >= 4;
}

function year(data) {
  return (data.date || "").match(/\d{4}/)?.[0] || "";
}

// Group raw Zotero items (as returned by the API) into probable-duplicate sets.
export function groupDuplicates(items) {
  const parent = new Map(items.map((i) => [i.key, i.key]));
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const reasons = new Map(); // root -> Set of "DOI" | "title"
  const byDOI = new Map();
  const byTitle = new Map();
  for (const it of items) {
    const d = it.data || {};
    const doi = itemDOI(d);
    if (doi) {
      if (byDOI.has(doi)) union(it.key, byDOI.get(doi));
      else byDOI.set(doi, it.key);
    }
    const norm = normaliseTitle(d.title, d.itemType);
    if (titleIsDistinctive(norm)) {
      if (byTitle.has(norm)) union(it.key, byTitle.get(norm));
      else byTitle.set(norm, it.key);
    }
  }

  const groups = new Map();
  for (const it of items) {
    const r = find(it.key);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  }

  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const dois = new Set(members.map((m) => itemDOI(m.data)).filter(Boolean));
    const titles = new Set(members.map((m) => normaliseTitle(m.data.title, m.data.itemType)));
    const matchedOn = [];
    // Shared DOI: at least two members carry the same one.
    const doiCounts = {};
    for (const m of members) {
      const d = itemDOI(m.data);
      if (d) doiCounts[d] = (doiCounts[d] || 0) + 1;
    }
    if (Object.values(doiCounts).some((n) => n > 1)) matchedOn.push("DOI");
    if (titles.size < members.length) matchedOn.push("title");
    const years = [...new Set(members.map((m) => year(m.data)).filter(Boolean))];
    const caution = [];
    if (dois.size > 1) {
      caution.push(
        "The copies carry different DOIs, which usually means a preprint and its published version. " +
          "They are the same work, but cite the published one."
      );
    }
    if (years.length > 1) {
      const span = Math.max(...years.map(Number)) - Math.min(...years.map(Number));
      if (span > 3) caution.push(`Years differ by ${span}; check these really are the same work before merging.`);
    }
    out.push({ members, matchedOn, caution });
  }
  return out;
}

// Rank copies so the best one to keep comes first. A published record beats a preprint, which beats
// a saved webpage; then a record with a DOI; then the one carrying the most notes and attachments
// (fewer things move); then the one added first (most likely to be the one already cited).
export function rankForKeeping(members, childCounts = {}) {
  const score = (m) => {
    const d = m.data || {};
    let s = 0;
    if (PUBLISHED_TYPES.has(d.itemType)) s += 1000;
    else if (d.itemType === "preprint") s += 500;
    else if (WEAK_TYPES.has(d.itemType)) s += 0;
    else s += 300;
    if (itemDOI(d)) s += 100;
    if (d.creators?.length) s += 50;
    if (year(d)) s += 20;
    s += Math.min(19, childCounts[m.key] || 0);
    return s;
  };
  return [...members].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff) return diff;
    return String(a.data.dateAdded || "").localeCompare(String(b.data.dateAdded || ""));
  });
}

export function keepReason(best, others) {
  const t = best.data.itemType;
  if (PUBLISHED_TYPES.has(t) && others.some((o) => !PUBLISHED_TYPES.has(o.data.itemType))) {
    return `the published ${t} rather than a preprint or saved page`;
  }
  if (t === "preprint" && others.every((o) => WEAK_TYPES.has(o.data.itemType))) {
    return "the preprint record rather than a saved webpage";
  }
  if (itemDOI(best.data) && others.some((o) => !itemDOI(o.data))) return "it has a DOI and the others do not";
  return "it carries the most notes and attachments, or was added first";
}
