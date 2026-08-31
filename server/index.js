#!/usr/bin/env node
// Zotero Connector for Claude — local-first MCP server.
// Reads via Zotero's local API (Zotero must be open); writes via the Zotero web API (API key),
// limited to collection membership and tags, with a journal so every change can be undone.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ZoteroError,
  localGET,
  resolveLibrary,
  getGroups,
  getAllCollections,
  buildCollectionTree,
  collectionPath,
  resolveCollection,
  getCollectionItems,
  searchItems,
  resolveItem,
  condenseItem,
  getChildren,
  getFullText,
  getPdfAttachments,
  getFilePath,
  exportBibtex,
  exportStyled,
  getUserID,
  webGetItemForWrite,
  webPatchItem,
  webCreateCollection,
  webDeleteCollection,
  webItemsWithTag,
  collectionSubtree,
  getItemTemplate,
  getCreatorTypes,
  webCreateItems,
  findExisting,
  pingLocal,
  LOCAL_TIMEOUT_MS,
  WEB_TIMEOUT_MS,
} from "./zotero.js";
import { appendEntry, readEntries, markUndone, journalPath } from "./journal.js";
import { lookup, LookupError, zoteroTypeFor, cslToZotero } from "./identifiers.js";

const ENABLE_WRITES = (process.env.ENABLE_WRITES || "true").toLowerCase() !== "false";
// Deletion is a separate switch. It requires ENABLE_WRITES as well.
const ENABLE_DELETES =
  ENABLE_WRITES && (process.env.ENABLE_DELETES || "true").toLowerCase() !== "false";

const server = new McpServer({ name: "zotero-connector", version: "1.2.0" });

const LIB_PARAM = z
  .string()
  .optional()
  .describe('Which library: "user" (default, your personal library) or a group library name/ID.');

function text(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}

function errText(e) {
  const msg = e instanceof ZoteroError || e instanceof LookupError ? e.message : `Unexpected error: ${e.message}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

const DELETE_NOTE =
  "IMPORTANT — this tool REMOVES things from the user's Zotero library. ALWAYS list the exact items or " +
  "collections by name and get explicit approval before calling it, even if the user earlier said to " +
  "proceed without asking about organizing; a blanket go-ahead for filing and tagging does NOT cover " +
  "deletion. Nothing is erased permanently: items go to Zotero's trash and can be restored from there " +
  "or with undo_changes.";

const CONFIRM_NOTE =
  "IMPORTANT — this tool MODIFIES the user's Zotero library. Unless the user has explicitly said to " +
  "proceed without asking, FIRST present the exact planned changes to the user in plain language and " +
  "get their approval, THEN call this tool. Every change is journaled and reversible via undo_changes.";

// ---------------------------------------------------------------- read tools

server.registerTool(
  "check_status",
  {
    title: "Check Zotero connection status",
    description:
      "Verify the connection to Zotero. Reports whether the Zotero app is reachable locally, whether an " +
      "API key is configured (needed only for organizing/write features), which group libraries are " +
      "available, and where the change journal is stored. Use this first if anything seems wrong.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const out = { local_api: "unknown", api_key: "not configured", groups: [], journal: journalPath() };
    try {
      const ms = await pingLocal();
      out.local_api = `connected (Zotero is open and reachable, responded in ${ms} ms)`;
      if (ms > 3000) {
        out.local_api +=
          " — that is slow for a local call; if requests start failing, quitting and reopening Zotero clears it";
      }
    } catch (e) {
      out.local_api = `NOT reachable — ${e.message}`;
    }
    out.timeouts = { local_ms: LOCAL_TIMEOUT_MS, web_ms: WEB_TIMEOUT_MS };
    if (process.env.ZOTERO_API_KEY) {
      try {
        const uid = await getUserID();
        out.api_key = `valid (user ID ${uid}) — organizing features available`;
      } catch (e) {
        out.api_key = `configured but not working: ${e.message}`;
      }
    } else {
      out.api_key = "not configured — read-only mode (add a key in extension settings to enable organizing)";
    }
    try {
      out.groups = (await getGroups()).map((g) => g.name);
    } catch (e) {
      /* ignore */
    }
    out.writes_enabled = ENABLE_WRITES;
    out.deletes_enabled = ENABLE_DELETES;
    return text(out);
  }
);

server.registerTool(
  "list_collections",
  {
    title: "List Zotero collections",
    description:
      "List the user's Zotero collections (folders) as a tree, including subcollections, item counts, and " +
      "available group libraries. Use this to find the collection a project's instructions refer to.",
    inputSchema: { library: LIB_PARAM },
    annotations: { readOnlyHint: true },
  },
  async ({ library }) => {
    try {
      const lib = await resolveLibrary(library);
      const cols = await getAllCollections(lib);
      const tree = buildCollectionTree(cols);
      const lines = [`Library: ${lib.label}`];
      const render = (nodes, depth) => {
        for (const n of nodes) {
          const count = n.numItems != null ? ` (${n.numItems} items)` : "";
          lines.push(`${"  ".repeat(depth)}- ${n.name}${count} [key: ${n.key}]`);
          render(n.children, depth + 1);
        }
      };
      render(tree, 0);
      if (!cols.length) lines.push("(no collections)");
      const groups = await getGroups();
      if (groups.length && lib.kind === "user") {
        lines.push("", "Group libraries also available: " + groups.map((g) => g.name).join(", "));
      }
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_collection_items",
  {
    title: "Get papers in a collection",
    description:
      "List the papers in a Zotero collection with title, authors, year, publication, tags, and abstract. " +
      "Accepts a collection name, a 'Parent/Child' path, or a collection key.",
    inputSchema: {
      collection: z.string().describe("Collection name, 'Parent/Child' path, or key."),
      library: LIB_PARAM,
      include_abstracts: z.boolean().optional().describe("Include abstracts (default true)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ collection, library, include_abstracts }) => {
    try {
      const lib = await resolveLibrary(library);
      const col = await resolveCollection(lib, collection);
      const items = await getCollectionItems(lib, col.key, { withAbstracts: include_abstracts !== false });
      return text({ library: lib.label, collection: col.path, collection_key: col.key, count: items.length, items });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_collection_abstracts",
  {
    title: "Bulk abstracts for relevance scanning",
    description:
      "Fetch titles + abstracts for ALL papers across one or more collections in a single call. Designed for " +
      "questions like 'look through the papers in these folders — do any seem relevant to X?'. Shortlist from " +
      "abstracts, then use read_paper to check the promising ones properly.",
    inputSchema: {
      collections: z.array(z.string()).min(1).describe("Collection names, paths, or keys."),
      library: LIB_PARAM,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ collections, library }) => {
    try {
      const lib = await resolveLibrary(library);
      const out = [];
      for (const c of collections) {
        const col = await resolveCollection(lib, c);
        const items = await getCollectionItems(lib, col.key, { withAbstracts: true });
        out.push({
          collection: col.path,
          count: items.length,
          items: items.map((i) => ({
            key: i.key,
            title: i.title,
            creators: i.creators,
            year: i.year,
            abstract: i.abstract || "(no abstract — use read_paper to check content)",
          })),
        });
      }
      return text({ library: lib.label, collections: out });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "search_library",
  {
    title: "Search the Zotero library",
    description:
      "Keyword search across the library. By default searches titles, authors, and years; set " +
      "search_fulltext=true to also search inside the indexed text of PDFs. Optionally filter by tag.",
    inputSchema: {
      query: z.string().describe("Search terms."),
      search_fulltext: z.boolean().optional().describe("Also search inside PDF text (default false)."),
      tag: z.string().optional().describe("Only items with this tag."),
      library: LIB_PARAM,
      limit: z.number().optional().describe("Max results (default 50)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, search_fulltext, tag, library, limit }) => {
    try {
      const lib = await resolveLibrary(library);
      const items = await searchItems(lib, {
        q: query,
        qmode: search_fulltext ? "everything" : "titleCreatorYear",
        tag,
        limit: limit || 50,
      });
      return text({ library: lib.label, query, count: items.length, items });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "read_paper",
  {
    title: "Read a paper's full text",
    description:
      "Get the full text of a paper from Zotero's index, plus its metadata and the PDF's location on disk. " +
      "Identify the paper by its item key (preferred) or title. Long papers are returned in chunks — the " +
      "response says how to fetch the next chunk. If a paper has no indexed text (e.g. an un-OCRed scan), " +
      "the PDF path is still returned so the file can be read directly.",
    inputSchema: {
      item: z.string().describe("Item key (8 chars) or title."),
      library: LIB_PARAM,
      offset: z.number().optional().describe("Character offset to continue from (default 0)."),
      max_chars: z.number().optional().describe("Max characters to return (default 80000)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ item, library, offset = 0, max_chars = 80000 }) => {
    try {
      const lib = await resolveLibrary(library);
      const it = await resolveItem(lib, item);
      const meta = condenseItem(it);
      const ft = await getFullText(lib, it.key);
      let pdfPath = null;
      try {
        const atts = await getPdfAttachments(lib, it.key);
        if (atts.length) pdfPath = await getFilePath(lib, atts[0].key);
      } catch (e) {
        /* ignore */
      }
      if (!ft) {
        return text({
          item: meta,
          pdf_path: pdfPath,
          fulltext: null,
          note:
            "No indexed full text for this item (possibly an un-OCRed scan, or Zotero hasn't indexed it yet). " +
            (pdfPath ? "The PDF exists at pdf_path and can be read directly." : "No PDF attachment found either."),
        });
      }
      const content = ft.content || "";
      const chunk = content.slice(offset, offset + max_chars);
      const remaining = Math.max(0, content.length - (offset + chunk.length));
      return text({
        item: meta,
        pdf_path: pdfPath,
        total_chars: content.length,
        offset,
        returned_chars: chunk.length,
        remaining_chars: remaining,
        next: remaining > 0 ? `Call read_paper again with offset=${offset + chunk.length} for the next chunk.` : null,
        fulltext: chunk,
      });
    } catch (e) {
      return errText(e);
    }
  }
);

function stripHtml(html) {
  return (html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

server.registerTool(
  "get_notes_and_annotations",
  {
    title: "Get the user's notes and highlights for a paper",
    description:
      "Retrieve the user's own Zotero notes and PDF highlights/annotations (made in Zotero's built-in reader) " +
      "for a given paper. Annotations made in external PDF readers are not visible to Zotero.",
    inputSchema: {
      item: z.string().describe("Item key (8 chars) or title."),
      library: LIB_PARAM,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ item, library }) => {
    try {
      const lib = await resolveLibrary(library);
      const it = await resolveItem(lib, item);
      const meta = condenseItem(it, { withAbstract: false });
      const children = await getChildren(lib, it.key);
      const notes = children
        .filter((c) => c.data.itemType === "note")
        .map((n) => ({ key: n.key, dateModified: n.data.dateModified, note: stripHtml(n.data.note) }));
      const annotations = [];
      for (const att of children.filter((c) => c.data.itemType === "attachment")) {
        const grand = await getChildren(lib, att.key);
        for (const a of grand.filter((g) => g.data.itemType === "annotation")) {
          annotations.push({
            type: a.data.annotationType,
            page: a.data.annotationPageLabel,
            highlighted_text: a.data.annotationText || undefined,
            comment: a.data.annotationComment || undefined,
            color: a.data.annotationColor,
          });
        }
      }
      return text({ item: meta, notes, annotations, counts: { notes: notes.length, annotations: annotations.length } });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "export_bibliography",
  {
    title: "Export BibTeX or a formatted bibliography",
    description:
      "Generate citations for a whole collection or a specific set of papers. format='bibtex' returns a .bib " +
      "ready for LaTeX; format='styled' returns a human-readable bibliography in a CSL style such as 'apa', " +
      "'chicago-note-bibliography', 'modern-language-association', or any style ID from the Zotero style repository.",
    inputSchema: {
      collection: z.string().optional().describe("Collection name/path/key (either this or items)."),
      items: z.array(z.string()).optional().describe("Item keys or titles (either this or collection)."),
      format: z.enum(["bibtex", "styled"]).describe("Output format."),
      style: z.string().optional().describe("CSL style for format='styled' (default 'apa')."),
      library: LIB_PARAM,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ collection, items, format, style, library }) => {
    try {
      const lib = await resolveLibrary(library);
      let collectionKey, itemKeys;
      if (items?.length) {
        itemKeys = [];
        for (const s of items) itemKeys.push((await resolveItem(lib, s)).key);
      } else if (collection) {
        collectionKey = (await resolveCollection(lib, collection)).key;
      } else {
        return errText(new ZoteroError("Provide either a collection or a list of items."));
      }
      const out =
        format === "bibtex"
          ? await exportBibtex(lib, { collectionKey, itemKeys })
          : await exportStyled(lib, { collectionKey, itemKeys, style: style || "apa" });
      return text(out || "(empty result)");
    } catch (e) {
      return errText(e);
    }
  }
);

// ------------------------------------------------------------ write plumbing

// Primitive operations; each returns true if it changed something.
async function applyPrimitive(lib, p) {
  switch (p.type) {
    case "collection_add": {
      const it = await webGetItemForWrite(lib, p.itemKey);
      const cols = it.data.collections || [];
      if (cols.includes(p.collectionKey)) return false;
      await webPatchItem(lib, p.itemKey, it.version, { collections: [...cols, p.collectionKey] });
      return true;
    }
    case "collection_remove": {
      const it = await webGetItemForWrite(lib, p.itemKey);
      const cols = it.data.collections || [];
      if (!cols.includes(p.collectionKey)) return false;
      await webPatchItem(lib, p.itemKey, it.version, { collections: cols.filter((c) => c !== p.collectionKey) });
      return true;
    }
    case "tag_add": {
      const it = await webGetItemForWrite(lib, p.itemKey);
      const tags = it.data.tags || [];
      if (tags.some((t) => t.tag === p.tag)) return false;
      await webPatchItem(lib, p.itemKey, it.version, { tags: [...tags, { tag: p.tag }] });
      return true;
    }
    case "tag_remove": {
      const it = await webGetItemForWrite(lib, p.itemKey);
      const tags = it.data.tags || [];
      if (!tags.some((t) => t.tag === p.tag)) return false;
      await webPatchItem(lib, p.itemKey, it.version, { tags: tags.filter((t) => t.tag !== p.tag) });
      return true;
    }
    case "collection_delete": {
      await webDeleteCollection(lib, p.collectionKey);
      return true;
    }
    case "item_trash": {
      const it = await webGetItemForWrite(lib, p.itemKey);
      if (it.data.deleted === 1 || it.data.deleted === true) return false;
      await webPatchItem(lib, p.itemKey, it.version, { deleted: 1 });
      return true;
    }
    case "item_restore": {
      const it = await webGetItemForWrite(lib, p.itemKey);
      if (!(it.data.deleted === 1 || it.data.deleted === true)) return false;
      await webPatchItem(lib, p.itemKey, it.version, { deleted: 0 });
      return true;
    }
    case "collection_restore_tree": {
      // Rebuild deleted collections shallowest first and refile their members. Zotero mints a new
      // key for each recreated collection, so parent references are remapped as we go.
      const keyMap = new Map();
      const nodes = [...(p.nodes || [])].sort((a, b) => a.depth - b.depth);
      for (const n of nodes) {
        const parentKey = n.parent ? keyMap.get(n.parent) || n.parent : null;
        const created = await webCreateCollection(lib, n.name, parentKey);
        keyMap.set(n.key, created.key);
        for (const itemKey of n.itemKeys || []) {
          try {
            const it = await webGetItemForWrite(lib, itemKey);
            const cols = it.data.collections || [];
            if (!cols.includes(created.key)) {
              await webPatchItem(lib, itemKey, it.version, { collections: [...cols, created.key] });
            }
          } catch (e) {
            // The item itself may have been trashed or removed since. Keep restoring the rest.
          }
        }
      }
      return true;
    }
    default:
      throw new ZoteroError(`Unknown operation type ${p.type}`);
  }
}

function inverseOf(p) {
  switch (p.type) {
    case "collection_add":
      return { ...p, type: "collection_remove" };
    case "collection_remove":
      return { ...p, type: "collection_add" };
    case "tag_add":
      return { ...p, type: "tag_remove" };
    case "tag_remove":
      return { ...p, type: "tag_add" };
    case "item_trash":
      return { ...p, type: "item_restore" };
    case "item_restore":
      return { ...p, type: "item_trash" };
    case "collection_create":
      return { type: "collection_delete", collectionKey: p.collectionKey };
    default:
      return null;
  }
}

async function runWrite(lib, description, primitives) {
  const performed = [];
  const errors = [];
  for (const p of primitives) {
    try {
      const changed = await applyPrimitive(lib, p);
      if (changed) performed.push(p);
    } catch (e) {
      errors.push({ op: p, error: e.message });
    }
  }
  let journalId = null;
  if (performed.length) {
    const inverses = performed.map(inverseOf).filter(Boolean).reverse();
    const entry = appendEntry({
      library: lib.kind === "user" ? "user" : `group:${lib.groupID}`,
      description,
      performed,
      inverse: inverses,
    });
    journalId = entry.id;
  }
  return { performed: performed.length, skipped: primitives.length - performed.length - errors.length, errors, change_id: journalId };
}

async function resolveItemKeys(lib, items) {
  const keys = [];
  for (const s of items) keys.push((await resolveItem(lib, s)).key);
  return keys;
}

const SYNC_NOTE =
  "Changes are made via zotero.org and appear in the desktop app on its next sync (usually within seconds; the user can also click the sync arrow in Zotero).";

// --------------------------------------------------------------- write tools

if (ENABLE_WRITES) {
  server.registerTool(
    "create_collection",
    {
      title: "Create a Zotero collection",
      description: `Create a new collection (folder), optionally inside a parent collection. ${CONFIRM_NOTE} ${SYNC_NOTE}`,
      inputSchema: {
        name: z.string().describe("Name for the new collection."),
        parent: z.string().optional().describe("Parent collection name/path/key (omit for top level)."),
        library: LIB_PARAM,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, parent, library }) => {
      try {
        const lib = await resolveLibrary(library);
        const parentKey = parent ? (await resolveCollection(lib, parent)).key : null;
        const created = await webCreateCollection(lib, name, parentKey);
        const entry = appendEntry({
          library: lib.kind === "user" ? "user" : `group:${lib.groupID}`,
          description: `Created collection "${name}"${parent ? ` inside "${parent}"` : ""}`,
          performed: [{ type: "collection_create", collectionKey: created.key, name }],
          inverse: [{ type: "collection_delete", collectionKey: created.key }],
        });
        return text({ created: name, key: created.key, change_id: entry.id, note: SYNC_NOTE });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "add_to_collection",
    {
      title: "Add papers to a collection",
      description: `Add one or more papers to a collection. Items stay in any other collections they're already in (Zotero collections are labels, so this never moves or destroys anything). ${CONFIRM_NOTE} ${SYNC_NOTE}`,
      inputSchema: {
        items: z.array(z.string()).min(1).describe("Item keys or titles."),
        collection: z.string().describe("Target collection name/path/key."),
        library: LIB_PARAM,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ items, collection, library }) => {
      try {
        const lib = await resolveLibrary(library);
        const col = await resolveCollection(lib, collection);
        const keys = await resolveItemKeys(lib, items);
        const res = await runWrite(
          lib,
          `Added ${keys.length} item(s) to collection "${col.path}"`,
          keys.map((k) => ({ type: "collection_add", itemKey: k, collectionKey: col.key }))
        );
        return text({ ...res, collection: col.path, note: SYNC_NOTE });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "remove_from_collection",
    {
      title: "Remove papers from a collection",
      description: `Remove one or more papers from a collection. The papers themselves stay in the library (and in any other collections) — only the folder membership changes. ${CONFIRM_NOTE} ${SYNC_NOTE}`,
      inputSchema: {
        items: z.array(z.string()).min(1).describe("Item keys or titles."),
        collection: z.string().describe("Collection name/path/key to remove them from."),
        library: LIB_PARAM,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ items, collection, library }) => {
      try {
        const lib = await resolveLibrary(library);
        const col = await resolveCollection(lib, collection);
        const keys = await resolveItemKeys(lib, items);
        const res = await runWrite(
          lib,
          `Removed ${keys.length} item(s) from collection "${col.path}"`,
          keys.map((k) => ({ type: "collection_remove", itemKey: k, collectionKey: col.key }))
        );
        return text({ ...res, collection: col.path, note: SYNC_NOTE });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "manage_tags",
    {
      title: "Add, remove, or rename tags",
      description: `Manage tags: action='add' adds a tag to the given items; action='remove' removes a tag from the given items (or from every item, if items omitted); action='rename' renames a tag across all items that have it. ${CONFIRM_NOTE} ${SYNC_NOTE}`,
      inputSchema: {
        action: z.enum(["add", "remove", "rename"]),
        tag: z.string().describe("The tag to add/remove, or the current name when renaming."),
        new_tag: z.string().optional().describe("New name (rename only)."),
        items: z.array(z.string()).optional().describe("Item keys or titles (required for 'add'; optional for 'remove')."),
        library: LIB_PARAM,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ action, tag, new_tag, items, library }) => {
      try {
        const lib = await resolveLibrary(library);
        let primitives = [];
        let description = "";
        if (action === "add") {
          if (!items?.length) return errText(new ZoteroError("'add' requires a list of items."));
          const keys = await resolveItemKeys(lib, items);
          primitives = keys.map((k) => ({ type: "tag_add", itemKey: k, tag }));
          description = `Added tag "${tag}" to ${keys.length} item(s)`;
        } else if (action === "remove") {
          const keys = items?.length
            ? await resolveItemKeys(lib, items)
            : (await webItemsWithTag(lib, tag)).map((i) => i.key);
          primitives = keys.map((k) => ({ type: "tag_remove", itemKey: k, tag }));
          description = `Removed tag "${tag}" from ${keys.length} item(s)`;
        } else {
          if (!new_tag) return errText(new ZoteroError("'rename' requires new_tag."));
          const tagged = await webItemsWithTag(lib, tag);
          for (const it of tagged) {
            primitives.push({ type: "tag_add", itemKey: it.key, tag: new_tag });
            primitives.push({ type: "tag_remove", itemKey: it.key, tag });
          }
          description = `Renamed tag "${tag}" to "${new_tag}" on ${tagged.length} item(s)`;
        }
        const res = await runWrite(lib, description, primitives);
        return text({ ...res, description, note: SYNC_NOTE });
      } catch (e) {
        return errText(e);
      }
    }
  );
  server.registerTool(
    "add_items_by_identifier",
    {
      title: "Add papers to Zotero from a DOI, arXiv ID, ISBN, or URL",
      description:
        "Look up one or more identifiers and create the matching items in the user's Zotero library. " +
        "Accepts DOIs, arXiv IDs, ISBNs, and ordinary URLs, mixed freely in one call. Metadata comes from " +
        "doi.org content negotiation, the arXiv API, Open Library or Google Books, and for a plain URL from " +
        "the page's own citation meta tags. This creates the record only; it does not download the PDF. " +
        "ALWAYS call with dry_run=true first, show the user the titles and authors that came back, and only " +
        "call again for real once they confirm, because a wrong identifier creates a wrong item. Items that " +
        "already appear to be in the library are skipped and reported. " +
        `${CONFIRM_NOTE} ${SYNC_NOTE}`,
      inputSchema: {
        identifiers: z
          .array(z.string())
          .min(1)
          .describe("DOIs, arXiv IDs, ISBNs, or URLs. Prefixes like 'doi:' or 'arXiv:' are fine."),
        collection: z.string().optional().describe("File the new items into this collection."),
        tags: z.array(z.string()).optional().describe("Tags to put on every new item."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Look up and report what would be created, without creating anything. Use this first."),
        allow_duplicates: z
          .boolean()
          .optional()
          .describe("Create items even when a match is already in the library (default false)."),
        library: LIB_PARAM,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ identifiers, collection, tags, dry_run, allow_duplicates, library }) => {
      try {
        const lib = await resolveLibrary(library);
        const col = collection ? await resolveCollection(lib, collection) : null;

        const resolved = [];
        const failures = [];
        const skipped = [];

        for (const raw of identifiers) {
          let found;
          try {
            found = await lookup(raw);
          } catch (e) {
            failures.push({ identifier: raw, error: e.message });
            continue;
          }
          const { csl, source } = found;
          let item;
          try {
            // Newer item types such as preprint and dataset do not exist in every Zotero version.
            // Rather than fail the identifier outright, fall back to a type that always exists and
            // let the field mapping drop whatever no longer fits.
            const candidates = [zoteroTypeFor(csl), "document", "journalArticle"];
            let template = null;
            let itemType = null;
            let lastErr = null;
            for (const t of candidates) {
              try {
                template = await getItemTemplate(t);
                itemType = t;
                break;
              } catch (err) {
                lastErr = err;
              }
            }
            if (!template) throw lastErr;
            const creatorTypes = await getCreatorTypes(itemType);
            item = cslToZotero(csl, template, { creatorTypes });
            if (itemType !== candidates[0]) item._downgraded_from = candidates[0];
          } catch (e) {
            failures.push({ identifier: raw, error: `Found the record but could not build a Zotero item: ${e.message}` });
            continue;
          }

          if (!allow_duplicates) {
            const existing = await findExisting(lib, { doi: csl.DOI, title: item.title });
            if (existing.length) {
              skipped.push({
                identifier: raw,
                title: item.title,
                reason: `already in the library as "${existing[0].title}" [${existing[0].key}], matched on ${existing[0].matchedOn}`,
              });
              continue;
            }
          }

          const downgraded = item._downgraded_from;
          delete item._downgraded_from;
          if (col) item.collections = [col.key];
          if (tags?.length) item.tags = tags.map((t) => ({ tag: t }));
          resolved.push({ identifier: raw, source, item, downgraded });
        }

        const preview = resolved.map((r) => ({
          identifier: r.identifier,
          metadata_from: r.source,
          itemType: r.item.itemType,
          note: r.downgraded ? `Zotero here has no "${r.downgraded}" type, so this was filed as ${r.item.itemType}.` : undefined,
          title: r.item.title,
          creators: (r.item.creators || []).map((c) => c.name || `${c.lastName}${c.firstName ? ", " + c.firstName : ""}`),
          date: r.item.date,
          publication: r.item.publicationTitle || r.item.proceedingsTitle || r.item.bookTitle || r.item.repository,
          DOI: r.item.DOI,
          url: r.item.url,
        }));

        if (dry_run) {
          return text({
            dry_run: true,
            would_create: preview,
            would_skip_as_duplicates: skipped,
            could_not_resolve: failures,
            next: "Show these to the user and get confirmation, then call again without dry_run.",
          });
        }

        if (!resolved.length) {
          return text({ created: [], skipped_as_duplicates: skipped, could_not_resolve: failures });
        }

        // The web API takes up to 50 objects per write.
        const created = [];
        const writeFailures = [];
        for (let i = 0; i < resolved.length; i += 50) {
          const batch = resolved.slice(i, i + 50);
          const res = await webCreateItems(lib, batch.map((r) => r.item));
          created.push(...res.created);
          for (const f of res.failed) {
            writeFailures.push({ identifier: batch[f.index]?.identifier, error: f.error });
          }
        }

        let journalId = null;
        if (created.length) {
          const entry = appendEntry({
            library: lib.kind === "user" ? "user" : `group:${lib.groupID}`,
            description:
              `Created ${created.length} item(s) from identifiers: ` +
              created.map((c) => c.title).join("; ") +
              (col ? ` (filed into "${col.path}")` : ""),
            performed: created.map((c) => ({ type: "item_create", itemKey: c.key, title: c.title })),
            // Undo trashes them, which is recoverable, rather than erasing anything.
            inverse: created.map((c) => ({ type: "item_trash", itemKey: c.key })).reverse(),
          });
          journalId = entry.id;
        }

        return text({
          created: created.map((c) => `${c.title} [${c.key}] (${c.itemType})`),
          filed_into: col?.path,
          skipped_as_duplicates: skipped,
          could_not_resolve: failures,
          write_failures: writeFailures,
          change_id: journalId,
          note: `Undo moves these to the trash rather than erasing them. ${SYNC_NOTE}`,
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

}

// -------------------------------------------------------------- delete tools

if (ENABLE_DELETES) {
  server.registerTool(
    "delete_items",
    {
      title: "Move papers to the Zotero trash (or restore them)",
      description:
        "Move one or more items to Zotero's trash, which is what pressing Delete in Zotero does. A trashed " +
        "item disappears from the library view and from every collection, keeps its PDF, and stays " +
        "recoverable from Zotero's Trash folder for 30 days. Nothing is erased permanently by this tool; " +
        "emptying the trash stays with the user in Zotero. Use action='restore' to bring trashed items back " +
        "(identify those by item key, since trashed items are hard to find by title). " +
        `${DELETE_NOTE} ${SYNC_NOTE}`,
      inputSchema: {
        items: z.array(z.string()).min(1).describe("Item keys (preferred) or titles."),
        action: z.enum(["trash", "restore"]).optional().describe("'trash' (default) or 'restore'."),
        library: LIB_PARAM,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ items, action, library }) => {
      try {
        const lib = await resolveLibrary(library);
        const mode = action === "restore" ? "restore" : "trash";
        const resolved = [];
        for (const spec of items) {
          try {
            const it = await resolveItem(lib, spec);
            resolved.push({ key: it.key, title: it.data?.title || it.key });
          } catch (e) {
            // Trashed items are filtered out of the local search index, so a restore has to be
            // able to fall back to a bare item key.
            if (/^[A-Z0-9]{8}$/.test(spec)) resolved.push({ key: spec, title: spec });
            else throw e;
          }
        }
        const description =
          mode === "trash"
            ? `Moved ${resolved.length} item(s) to the trash: ${resolved.map((r) => r.title).join("; ")}`
            : `Restored ${resolved.length} item(s) from the trash: ${resolved.map((r) => r.title).join("; ")}`;
        const res = await runWrite(
          lib,
          description,
          resolved.map((r) => ({ type: mode === "trash" ? "item_trash" : "item_restore", itemKey: r.key }))
        );
        return text({
          ...res,
          action: mode,
          items: resolved.map((r) => `${r.title} [${r.key}]`),
          note:
            mode === "trash"
              ? `In Zotero's Trash, recoverable there for 30 days, or reversible with undo_changes. ${SYNC_NOTE}`
              : SYNC_NOTE,
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "delete_collection",
    {
      title: "Delete a Zotero collection",
      description:
        "Delete a collection (folder). The papers inside are NOT deleted. They stay in the library and in " +
        "any other collections they belong to, and only lose this one folder. To remove the papers as well, " +
        "call delete_items separately. Refuses by default when the collection has subcollections; pass " +
        "include_subcollections=true to delete the whole branch. Undo recreates the folders and refiles " +
        "everything that was in them. " +
        `${DELETE_NOTE} ${SYNC_NOTE}`,
      inputSchema: {
        collection: z.string().describe("Collection name, 'Parent/Child' path, or key."),
        include_subcollections: z
          .boolean()
          .optional()
          .describe("Also delete every collection nested inside it (default false)."),
        library: LIB_PARAM,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ collection, include_subcollections, library }) => {
      try {
        const lib = await resolveLibrary(library);
        const col = await resolveCollection(lib, collection);
        // Captured before anything is deleted, so undo has the names, nesting and membership.
        const subtree = await collectionSubtree(lib, col.key);
        const children = subtree.filter((n) => n.key !== col.key);
        if (children.length && !include_subcollections) {
          return errText(
            new ZoteroError(
              `"${col.path}" contains ${children.length} subcollection(s): ${children
                .map((c) => c.path)
                .join(", ")}. Deleting it would take those too. Call again with ` +
                "include_subcollections=true if that is intended, or move the subcollections out first."
            )
          );
        }
        const performed = [];
        const errors = [];
        for (const n of subtree) {
          // subtree is deepest-first, so no collection is removed before its children.
          try {
            await webDeleteCollection(lib, n.key);
            performed.push({ type: "collection_delete", collectionKey: n.key, name: n.name, path: n.path });
          } catch (e) {
            errors.push({ collection: n.path, error: e.message });
          }
        }
        let journalId = null;
        if (performed.length) {
          const nodes = subtree
            .filter((n) => performed.some((d) => d.collectionKey === n.key))
            .map(({ key, name, parent, depth, itemKeys }) => ({ key, name, parent, depth, itemKeys }));
          const entry = appendEntry({
            library: lib.kind === "user" ? "user" : `group:${lib.groupID}`,
            description:
              `Deleted collection "${col.path}"` +
              (performed.length > 1 ? ` and ${performed.length - 1} subcollection(s)` : ""),
            performed,
            inverse: [{ type: "collection_restore_tree", nodes }],
          });
          journalId = entry.id;
        }
        return text({
          deleted: performed.map((d) => d.path),
          papers_left_untouched_in_library: subtree.reduce((n, c) => n + (c.itemKeys?.length || 0), 0),
          errors,
          change_id: journalId,
          note: `Undo recreates the folder(s) and refiles their papers. ${SYNC_NOTE}`,
        });
      } catch (e) {
        return errText(e);
      }
    }
  );
}

// -------------------------------------------------------------- history/undo

server.registerTool(
  "list_recent_changes",
  {
    title: "List recent changes Claude made to Zotero",
    description:
      "Show the journal of changes this connector has made to the user's Zotero library (newest first), " +
      "including whether each has been undone. Use the change IDs with undo_changes to reverse specific ones.",
    inputSchema: {
      limit: z.number().optional().describe("Max entries to return (default 20)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ limit = 20 }) => {
    try {
      const entries = readEntries().slice(-limit).reverse();
      if (!entries.length) return text("No changes have been made to the Zotero library by this connector.");
      return text(
        entries.map((e) => ({
          id: e.id,
          when: e.ts,
          library: e.library,
          description: e.description,
          operations: e.performed?.length ?? 0,
          undone: e.undone,
        }))
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "undo_changes",
  {
    title: "Undo changes made to Zotero",
    description:
      "Reverse changes previously made by this connector. Provide specific change IDs (from " +
      "list_recent_changes), or last_n to undo the N most recent not-yet-undone changes. " +
      `${CONFIRM_NOTE}`,
    inputSchema: {
      change_ids: z.array(z.string()).optional().describe("Specific change IDs to undo."),
      last_n: z.number().optional().describe("Undo the N most recent changes instead."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ change_ids, last_n }) => {
    try {
      const all = readEntries();
      let targets = [];
      if (change_ids?.length) {
        targets = all.filter((e) => change_ids.includes(e.id));
        const missing = change_ids.filter((id) => !all.some((e) => e.id === id));
        if (missing.length) return errText(new ZoteroError(`Unknown change IDs: ${missing.join(", ")}`));
      } else if (last_n) {
        targets = all.filter((e) => !e.undone).slice(-last_n);
      } else {
        return errText(new ZoteroError("Provide change_ids or last_n."));
      }
      targets = targets.filter((e) => !e.undone).reverse(); // undo newest first
      if (!targets.length) return text("Nothing to undo (the specified changes are already undone).");
      const results = [];
      for (const entry of targets) {
        const lib =
          entry.library === "user"
            ? await resolveLibrary("user")
            : await resolveLibrary(entry.library.replace("group:", ""));
        const errors = [];
        let reversed = 0;
        for (const inv of entry.inverse || []) {
          try {
            await applyPrimitive(lib, inv);
            reversed++;
          } catch (e) {
            errors.push(e.message);
          }
        }
        if (!errors.length) markUndone([entry.id]);
        results.push({ id: entry.id, description: entry.description, reversed, errors });
      }
      return text({ undone: results, note: SYNC_NOTE });
    } catch (e) {
      return errText(e);
    }
  }
);

// -------------------------------------------------------------------- launch

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Zotero connector MCP server running (writes " + (ENABLE_WRITES ? "enabled" : "disabled") + ")");
