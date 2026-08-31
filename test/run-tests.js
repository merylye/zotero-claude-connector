// End-to-end test: spins up mock Zotero APIs, connects to the MCP server over stdio, exercises every tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startLocal, startWeb, startBlackHole, blackHole, state } from "./mock-zotero.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zot-journal-"));
startLocal(23119);
startWeb(8123);

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../server/index.js", import.meta.url).pathname],
  env: {
    ...process.env,
    ZOTERO_LOCAL_BASE: "http://127.0.0.1:23119/api",
    ZOTERO_WEB_BASE: "http://127.0.0.1:8123",
    ZOTERO_API_KEY: "testkey123",
    ZOTERO_CONNECTOR_DATA_DIR: dataDir,
    ENABLE_WRITES: "true",
    DOI_RESOLVER_BASE: "http://127.0.0.1:8123/doi",
    ARXIV_API_BASE: "http://127.0.0.1:8123/arxiv",
    OPENLIBRARY_BASE: "http://127.0.0.1:8123",
    GOOGLE_BOOKS_BASE: "http://127.0.0.1:8123",
  },
});
const client = new Client({ name: "test", version: "0.0.1" });
await client.connect(transport);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const t = res.content?.[0]?.text || "";
  return { text: t, isError: !!res.isError };
}

// tool listing
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));
check("all 17 tools registered", tools.length === 17, tools.join(", "));
check("delete tools registered", tools.includes("delete_items") && tools.includes("delete_collection"));

// check_status
let r = await call("check_status");
check("check_status connects", r.text.includes("connected") && r.text.includes("valid (user ID 1234)"), r.text);

// list_collections
r = await call("list_collections", {});
check("list_collections tree", r.text.includes("Metaphor Study") && r.text.includes("  - Methods") && r.text.includes("CogSci Lab"), r.text);

// get_collection_items by name
r = await call("get_collection_items", { collection: "Metaphor Study" });
check("get_collection_items", r.text.includes("Conceptual Metaphor") && r.text.includes("Glucksberg"), r.text);

// nested path resolution
r = await call("get_collection_items", { collection: "Metaphor Study/Methods" });
check("nested collection path", r.text.includes("Computational Model") && !r.text.includes("Conceptual Metaphor in Everyday"), r.text);

// unknown collection error lists options
r = await call("get_collection_items", { collection: "Nope" });
check("unknown collection helpful error", r.isError && r.text.includes("Metaphor Study"), r.text);

// bulk abstracts
r = await call("get_collection_abstracts", { collections: ["Metaphor Study", "Unsorted"] });
check("bulk abstracts", r.text.includes("pervasive in everyday life") && r.text.includes("figurative language"), r.text);

// search: metadata mode should NOT hit fulltext-only terms
r = await call("search_library", { query: "FULL TEXT START" });
check("metadata search misses fulltext", r.text.includes('"count": 0'), r.text);
r = await call("search_library", { query: "FULL TEXT START", search_fulltext: true });
check("fulltext search hits", r.text.includes("Conceptual Metaphor"), r.text);
r = await call("search_library", { query: "lakoff" });
check("author search", r.text.includes("Conceptual Metaphor"), r.text);

// read_paper with chunking
r = await call("read_paper", { item: "ITEM0001", max_chars: 100 });
check("read_paper chunk 1", r.text.includes("FULL TEXT START") && r.text.includes("offset=100"), r.text.slice(0, 400));
const totalMatch = r.text.match(/"total_chars": (\d+)/);
r = await call("read_paper", { item: "ITEM0001", offset: Number(totalMatch[1]) - 20 });
check("read_paper last chunk", r.text.includes("FULL TEXT END") && r.text.includes('"remaining_chars": 0'), r.text.slice(0, 400));
r = await call("read_paper", { item: "Conceptual Metaphor" });
check("read_paper by title + pdf path", r.text.includes("Lakoff-Johnson-1980.pdf") && r.text.includes("/home/testuser/Zotero/storage"), r.text.slice(0, 500));
r = await call("read_paper", { item: "ITEM0003" });
check("read_paper no fulltext note", r.text.includes("No indexed full text"), r.text.slice(0, 400));

// notes & annotations
r = await call("get_notes_and_annotations", { item: "ITEM0001" });
check("notes stripped of html", r.text.includes("Key claim: metaphors structure thought."), r.text);
check("annotations present", r.text.includes("Metaphor is pervasive") && r.text.includes("central thesis"), r.text);

// bibliography
r = await call("export_bibliography", { collection: "Metaphor Study", format: "bibtex" });
check("bibtex export (local)", r.text.includes("@article{lakoff1980"), r.text);
r = await call("export_bibliography", { collection: "Metaphor Study", format: "styled", style: "chicago-note-bibliography" });
check("styled export falls back to web", r.text.includes("[chicago-note-bibliography] Lakoff (1980)"), r.text);
r = await call("export_bibliography", { items: ["ITEM0002"], format: "styled" });
check("styled export by items", r.text.includes("[apa] Glucksberg"), r.text);

// ---- writes ----
r = await call("create_collection", { name: "To Review", parent: "Metaphor Study" });
check("create_collection", r.text.includes('"created": "To Review"') && r.text.includes("chg_"), r.text);
const newColKey = Object.values(state.collections).find((c) => c.data.name === "To Review")?.key;
check("collection exists in mock", !!newColKey);

r = await call("add_to_collection", { items: ["ITEM0003"], collection: "To Review" });
check("add_to_collection", r.text.includes('"performed": 1'), r.text);
check("mock item now in collection", state.items.ITEM0003.data.collections.includes(newColKey));

r = await call("add_to_collection", { items: ["ITEM0003"], collection: "To Review" });
check("idempotent add skipped", r.text.includes('"performed": 0'), r.text);

r = await call("manage_tags", { action: "add", tag: "to-review", items: ["ITEM0003", "ITEM0002"] });
check("tag add", r.text.includes('"performed": 2'), r.text);
check("mock has tag", state.items.ITEM0003.data.tags.some((t) => t.tag === "to-review"));

r = await call("manage_tags", { action: "rename", tag: "to-review", new_tag: "needs-review" });
check("tag rename", r.text.includes("Renamed tag") && r.text.includes('"performed": 4'), r.text);
check("mock renamed", state.items.ITEM0002.data.tags.some((t) => t.tag === "needs-review") && !state.items.ITEM0002.data.tags.some((t) => t.tag === "to-review"));

r = await call("remove_from_collection", { items: ["ITEM0002"], collection: "Methods" });
check("remove_from_collection", r.text.includes('"performed": 1'), r.text);
check("mock removed", !state.items.ITEM0002.data.collections.includes("BBBB2222"));

// history
r = await call("list_recent_changes", {});
check("journal lists changes", r.text.includes("Created collection") && r.text.includes("Renamed tag"), r.text);
const ids = [...r.text.matchAll(/"id": "(chg_[^"]+)"/g)].map((m) => m[1]);
check("5 journal entries", ids.length === 5, `got ${ids.length}`);

// undo everything, newest-first
r = await call("undo_changes", { last_n: 5 });
check("undo runs", r.text.includes("undone"), r.text);
check("undo: item back in Methods", state.items.ITEM0002.data.collections.includes("BBBB2222"));
check("undo: tag rename reverted", !state.items.ITEM0002.data.tags.some((t) => t.tag === "needs-review") && state.items.ITEM0002.data.tags.some((t) => t.tag === "metaphor"));
check("undo: tag add reverted", !state.items.ITEM0003.data.tags.some((t) => t.tag === "to-review" || t.tag === "needs-review"));
check("undo: collection membership reverted", !state.items.ITEM0003.data.collections.includes(newColKey));
check("undo: created collection deleted", !state.collections[newColKey]);

r = await call("undo_changes", { last_n: 5 });
check("double undo is a no-op", r.text.includes("Nothing to undo"), r.text);

r = await call("list_recent_changes", {});
check("journal marks undone", (r.text.match(/"undone": true/g) || []).length === 5, r.text);

// ---- deletion ----

// Trash an item: it leaves every listing, keeps its record, and is journaled.
r = await call("delete_items", { items: ["ITEM0003"] });
check("delete_items trashes", r.text.includes('"performed": 1') && r.text.includes("Trash"), r.text);
check("mock item marked deleted", state.items.ITEM0003.data.deleted === 1);
r = await call("get_collection_items", { collection: "Unsorted" });
check("trashed item hidden from collection", !r.text.includes("Neural Networks"), r.text);
r = await call("search_library", { query: "figurative" });
check("trashed item hidden from search", r.text.includes('"count": 0'), r.text);

// Trashing twice changes nothing.
r = await call("delete_items", { items: ["ITEM0003"] });
check("re-trash is a no-op", r.text.includes('"performed": 0'), r.text);

// Restore by key, since a trashed item can no longer be found by title.
r = await call("delete_items", { items: ["ITEM0003"], action: "restore" });
check("delete_items restores", r.text.includes('"performed": 1'), r.text);
check("mock item restored", state.items.ITEM0003.data.deleted === 0);

// Trash, then undo through the journal rather than the restore action.
r = await call("delete_items", { items: ["ITEM0002"] });
const trashChange = r.text.match(/"change_id": "(chg_[^"]+)"/)[1];
check("mock ITEM0002 trashed", state.items.ITEM0002.data.deleted === 1);
r = await call("undo_changes", { change_ids: [trashChange] });
check("undo restores trashed item", state.items.ITEM0002.data.deleted === 0, r.text);

// Collection deletion, including the refusal on a branch with children.
await call("create_collection", { name: "Trash Me", parent: "Metaphor Study" });
await call("create_collection", { name: "Sub Folder", parent: "Trash Me" });
await call("add_to_collection", { items: ["ITEM0001"], collection: "Sub Folder" });
const subKeyBefore = Object.values(state.collections).find((c) => c.data.name === "Sub Folder").key;
check("nested test collection filed", state.items.ITEM0001.data.collections.includes(subKeyBefore));

r = await call("delete_collection", { collection: "Trash Me" });
check("delete_collection refuses a branch", r.isError && r.text.includes("Sub Folder") && r.text.includes("include_subcollections"), r.text);
check("nothing deleted on refusal", !!Object.values(state.collections).find((c) => c.data.name === "Trash Me"));

r = await call("delete_collection", { collection: "Trash Me", include_subcollections: true });
check("delete_collection removes branch", r.text.includes("Trash Me") && r.text.includes("chg_"), r.text);
check("both collections gone", !Object.values(state.collections).some((c) => ["Trash Me", "Sub Folder"].includes(c.data.name)));
check("papers survive collection deletion", !!state.items.ITEM0001 && state.items.ITEM0001.data.deleted !== 1);

r = await call("undo_changes", { last_n: 1 });
const rebuiltSub = Object.values(state.collections).find((c) => c.data.name === "Sub Folder");
const rebuiltParent = Object.values(state.collections).find((c) => c.data.name === "Trash Me");
check("undo rebuilds both collections", !!rebuiltSub && !!rebuiltParent, r.text);
check("undo restores nesting", rebuiltSub?.data.parentCollection === rebuiltParent?.key, JSON.stringify(rebuiltSub?.data));
check("undo refiles the paper", state.items.ITEM0001.data.collections.includes(rebuiltSub?.key));

// ---- creating items from identifiers ----

// Dry run resolves metadata and creates nothing.
r = await call("add_items_by_identifier", { identifiers: ["10.1145/3411764.3445374"], dry_run: true });
check("dry run resolves a DOI", r.text.includes("Designing for Reflection") && r.text.includes('"dry_run": true'), r.text.slice(0, 600));
check("dry run maps the item type", r.text.includes("conferencePaper"), r.text.slice(0, 600));
check("dry run creates nothing", !Object.values(state.items).some((i) => i.data.title === "Designing for Reflection in Collaborative Systems"));

// The real thing.
r = await call("add_items_by_identifier", { identifiers: ["doi:10.1145/3411764.3445374"], collection: "Metaphor Study" });
const doiItem = Object.values(state.items).find((i) => i.data.title === "Designing for Reflection in Collaborative Systems");
check("DOI item created", !!doiItem, r.text.slice(0, 600));
check("conference fields mapped", doiItem?.data.proceedingsTitle?.startsWith("Proceedings of the 2021 CHI"), JSON.stringify(doiItem?.data));
check("creators mapped", doiItem?.data.creators?.[0]?.lastName === "Okafor" && doiItem?.data.creators?.[0]?.creatorType === "author", JSON.stringify(doiItem?.data.creators));
check("date mapped", doiItem?.data.date === "2021-05-06", doiItem?.data.date);
check("conference name from the event field", doiItem?.data.conferenceName?.startsWith("CHI '21"), JSON.stringify(doiItem?.data.conferenceName));
check("place from Crossref publisher-location", doiItem?.data.place === "New York, NY, USA", JSON.stringify(doiItem?.data.place));
check("pages and DOI mapped", doiItem?.data.pages === "1-14" && doiItem?.data.DOI === "10.1145/3411764.3445374", JSON.stringify(doiItem?.data));
check("filed into the collection", doiItem?.data.collections?.includes("AAAA1111"), JSON.stringify(doiItem?.data.collections));

// Duplicate detection on a second attempt.
r = await call("add_items_by_identifier", { identifiers: ["10.1145/3411764.3445374"] });
check("duplicate skipped by DOI", r.text.includes("already in the library") && r.text.includes("matched on DOI"), r.text.slice(0, 500));
r = await call("add_items_by_identifier", { identifiers: ["10.1145/3411764.3445374"], allow_duplicates: true });
check("allow_duplicates overrides", r.text.includes('"created"') && !r.text.includes("already in the library"), r.text.slice(0, 400));

// arXiv, with and without a published DOI.
r = await call("add_items_by_identifier", { identifiers: ["arXiv:2303.08774"], tags: ["from-arxiv"] });
const arx = Object.values(state.items).find((i) => i.data.title === "Transformers For Everything");
check("arXiv item created as a preprint", arx?.data.itemType === "preprint", JSON.stringify(arx?.data.itemType));
check("arXiv authors parsed", arx?.data.creators?.length === 2, JSON.stringify(arx?.data.creators));
check("tags applied", arx?.data.tags?.some((t) => t.tag === "from-arxiv"), JSON.stringify(arx?.data.tags));
r = await call("add_items_by_identifier", { identifiers: ["2401.00001"] });
const pub = Object.values(state.items).find((i) => i.data.title === "A Published Version Of The Preprint");
check("arXiv defers to its published DOI", !!pub && pub.data.itemType === "journalArticle", r.text.slice(0, 500));
check("journal fields from the DOI record", pub?.data.publicationTitle?.startsWith("Science & Society") && pub?.data.volume === "7", JSON.stringify(pub?.data));
check("HTML entities decoded, not passed through", !!pub && !/&amp;|&#\d+;/.test(pub.data.publicationTitle) && pub.data.publicationTitle.includes("\u2014"), JSON.stringify(pub?.data.publicationTitle));
check("legacy dx.doi.org url normalised", pub?.data.url === "https://doi.org/10.9999/preprint.2024", JSON.stringify(pub?.data.url));

// ISBN.
r = await call("add_items_by_identifier", { identifiers: ["978-0-226-46801-3"] });
const bk = Object.values(state.items).find((i) => i.data.title === "Metaphors We Live By");
check("ISBN book created", bk?.data.itemType === "book", r.text.slice(0, 500));
check("book publisher and pages", bk?.data.publisher === "University of Chicago Press" && bk?.data.numPages === "242", JSON.stringify(bk?.data));

// Crossref's own type vocabulary, which is what a live DOI actually returns.
r = await call("add_items_by_identifier", { identifiers: ["10.1101/2020.03.20.000133"] });
const pre = Object.values(state.items).find((i) => i.data.title === "Deep Learning For Bioimaging Without The Barriers");
check("posted-content becomes a preprint", pre?.data.itemType === "preprint", r.text.slice(0, 400));
check("preprint repository from institution", pre?.data.repository === "bioRxiv", JSON.stringify(pre?.data.repository));
check("JATS markup stripped from the abstract", !!pre && !/<jats:|<\/jats:/.test(pre.data.abstractNote) && pre.data.abstractNote.includes("significant barriers"), JSON.stringify(pre?.data.abstractNote));
check("empty container-title array ignored", !pre?.data.publicationTitle, JSON.stringify(pre?.data.publicationTitle));

r = await call("add_items_by_identifier", { identifiers: ["10.1017/CBO9780511815355"] });
const mono = Object.values(state.items).find((i) => i.data.title === "A Monograph About Method");
check("monograph becomes a book", mono?.data.itemType === "book", r.text.slice(0, 400));
check("first ISBN taken from the array", mono?.data.ISBN === "9780511815355", JSON.stringify(mono?.data.ISBN));

// A URL with citation meta tags, and one without.
r = await call("add_items_by_identifier", { identifiers: ["http://127.0.0.1:8123/page/with-meta"] });
const web = Object.values(state.items).find((i) => i.data.title === "Situated Knowledge In Practice");
check("URL with meta tags becomes a journal article", web?.data.itemType === "journalArticle", r.text.slice(0, 500));
check("meta tag fields mapped", web?.data.publicationTitle === "Studies in Method" && web?.data.pages === "200-219", JSON.stringify(web?.data));
check("meta tag authors parsed", web?.data.creators?.[0]?.lastName === "Haraway", JSON.stringify(web?.data.creators));
r = await call("add_items_by_identifier", { identifiers: ["http://127.0.0.1:8123/page/bare"] });
check("bare page falls back to a webpage item", r.text.includes("Just A Blog Post") && r.text.includes("webpage"), r.text.slice(0, 500));

// Nonsense in, useful error out, and one bad identifier does not sink the batch.
r = await call("add_items_by_identifier", { identifiers: ["not an identifier at all"] });
check("unrecognisable identifier explains itself", r.text.includes("Could not tell what"), r.text.slice(0, 400));
r = await call("add_items_by_identifier", { identifiers: ["10.9999/does-not-exist", "10.9999/preprint.2024"], allow_duplicates: true });
check("batch survives one bad identifier", r.text.includes("could_not_resolve") && r.text.includes("A Published Version"), r.text.slice(0, 600));

// Undo trashes what was created rather than erasing it.
r = await call("add_items_by_identifier", { identifiers: ["10.9999/preprint.2024"], allow_duplicates: true });
const undoTarget = r.text.match(/"change_id": "(chg_[^"]+)"/)[1];
const madeKey = r.text.match(/\[([A-Z0-9]{8})\]/)[1];
check("created item is live", state.items[madeKey]?.data.deleted !== 1);
r = await call("undo_changes", { change_ids: [undoTarget] });
check("undo trashes the created item", state.items[madeKey]?.data.deleted === 1, r.text.slice(0, 400));
check("undo does not erase the record", !!state.items[madeKey]);

// ---- the timeout fix ----
// A Zotero that accepts connections but never answers must produce an error, not a hang.
startBlackHole(8199);
const stallTransport = new StdioClientTransport({
  command: "node",
  args: [new URL("../server/index.js", import.meta.url).pathname],
  env: {
    ...process.env,
    ZOTERO_LOCAL_BASE: "http://127.0.0.1:8199/api",
    ZOTERO_WEB_BASE: "http://127.0.0.1:8123",
    ZOTERO_API_KEY: "testkey123",
    ZOTERO_CONNECTOR_DATA_DIR: dataDir,
    ZOTERO_LOCAL_TIMEOUT_MS: "2000",
  },
});
const stallClient = new Client({ name: "test-stall", version: "0.0.1" });
await stallClient.connect(stallTransport);
const started = Date.now();
const stalled = await stallClient.callTool({ name: "list_collections", arguments: {} });
const elapsed = Date.now() - started;
const stallText = stalled.content?.[0]?.text || "";
check("stalled Zotero errors instead of hanging", !!stalled.isError, stallText);
check("stall error names the fix", stallText.includes("Quit Zotero and open it again"), stallText);
check(`stall gives up promptly (${elapsed}ms)`, elapsed < 12000, `${elapsed}ms`);
check(`stalled GET retried once (${blackHole.connections} connections)`, blackHole.connections >= 2, String(blackHole.connections));
await stallClient.close();

console.log(`\n${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
