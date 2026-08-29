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
check("all 16 tools registered", tools.length === 16, tools.join(", "));
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
