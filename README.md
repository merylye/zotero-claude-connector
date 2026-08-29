# Zotero Claude Connector

A local MCP server that connects [Zotero](https://www.zotero.org/) to Claude Desktop. Ask Claude
about the papers in your own library instead of uploading PDFs into a project, one file at a time,
until you run out of space.

It ships as a one-click `.mcpb` desktop extension with a bundled runtime, so installing it takes a
double-click and no terminal.

## Disclaimer

**This software is provided as-is, with no warranty of any kind. I am not responsible for any
errors, data loss, or damage arising from its use. Use it at your own risk.**

That is what the [MIT license](LICENSE) says in legal terms, and it is worth saying plainly here
too, because this tool can change your Zotero library. It can file papers, edit tags, move items to
Zotero's trash, and delete collections. It cannot erase anything permanently, and every change it
makes is journaled and reversible, but no amount of care in the code substitutes for your own
backup. **Back up your Zotero library before giving any tool write access to it**, including this
one. Zotero's own sync is not a backup; it will happily propagate a mistake to every device you own.

If you would rather not take the risk, leave the API key field blank at install time. Everything in
the read-only half of the tool works without it, and Claude then has no way to change anything.

## What it does

Reading, through Zotero's local API, with no API key and no cloud round-trip:

- browse collections as a tree, including nested folders and group libraries
- list papers in a collection with authors, year, tags, and abstracts
- pull titles and abstracts across several collections at once, for "does anything here relate to X"
- keyword search, optionally inside the indexed full text of your PDFs
- read a paper's full text, chunked, with the PDF's path on disk
- retrieve your own notes and the highlights you made in Zotero's reader
- export BibTeX, or a formatted bibliography in APA, Chicago, MLA, or any CSL style

Organizing, through the Zotero web API, which needs an API key:

- create collections, file papers into them, remove them from collections
- add, remove, and rename tags
- move items to Zotero's trash, and restore them
- delete a collection, leaving its papers in the library

History:

- every change is journaled to `~/.zotero-claude-connector/journal.jsonl` with its exact inverse
- `list_recent_changes` shows what Claude has done, `undo_changes` reverses any of it, singly or in
  bulk ("undo everything from this afternoon")

## Install

1. Download `dist/zotero-connector-1.1.0.mcpb` from this repo.
2. In Zotero, open **Settings → Advanced** and check
   **"Allow other applications on this computer to communicate with Zotero"**.
3. Double-click the `.mcpb`, or drag it onto the Claude Desktop window, and click Install.
4. Optional, for organizing. Create a key at <https://www.zotero.org/settings/keys/new> with
   **Allow library access** and **Allow write access** (plus group permissions if you use group
   libraries), then paste it into **Settings → Extensions → Zotero Connector** in Claude Desktop.
5. Ask Claude "check my Zotero connection status" to confirm.

Three switches live in the same settings panel: organizing on or off, deleting on or off, and how
long to wait for Zotero before giving up.

## Using it

Point a Claude project at a collection with one line in its instructions:

> My references for this project are in the Zotero collection "Metaphor Study". Use the Zotero
> connector to look up, read, and cite papers from there instead of uploaded files.

Nested paths work (`Dissertation/Chapter 2`), and so do group libraries ("the collection 'Stimuli'
in the group library 'CogSci Lab'").

Then ask ordinary questions. "What's in my Chapter 2 folder?" "Do any papers in Metaphor Study and
Unsorted relate to embodied simulation?" "Read the Glucksberg paper and compare its model to Chen's."
"What did I highlight in Lakoff?" "Give me a .bib for the whole collection." "Create a To Read
subcollection and file everything tagged to-read into it."

## Tool reference

Sixteen tools. Most take an optional `library`, which is `"user"` (the default, your personal
library) or a group library's name or ID. Papers are identified by their 8-character Zotero item key
or by title; collections by name, by a `Parent/Child` path, or by key.

### Reading (local API, no key required)

| Tool | Parameters | What it returns |
| --- | --- | --- |
| `check_status` | none | Whether Zotero is reachable and how fast it answered, whether a key is configured, available group libraries, the journal path, and the active timeouts |
| `list_collections` | | The collection tree with item counts and keys, plus group libraries |
| `get_collection_items` | `collection`, `include_abstracts` | Title, authors, year, venue, DOI, tags, and abstract for each paper |
| `get_collection_abstracts` | `collections[]` | Titles and abstracts across several collections at once, for relevance scans |
| `search_library` | `query`, `search_fulltext`, `tag`, `limit` | Matching papers. `search_fulltext` searches Zotero's indexed PDF text rather than only metadata |
| `read_paper` | `item`, `offset`, `max_chars` | Full text in chunks, with metadata and the PDF's path on disk. Defaults to 80,000 characters and reports how much remains |
| `get_notes_and_annotations` | `item` | Your notes with HTML stripped, and highlights from Zotero's reader with page, colour, and comment |
| `export_bibliography` | `collection` or `items[]`, `format`, `style` | `format: "bibtex"` for a .bib, `format: "styled"` for prose in any CSL style (`apa`, `chicago-note-bibliography`, and so on) |

### Organizing (web API, needs a key)

| Tool | Parameters | Effect |
| --- | --- | --- |
| `create_collection` | `name`, `parent` | Creates a folder, optionally nested |
| `add_to_collection` | `items[]`, `collection` | Files papers into a folder. Zotero collections are labels, so this never moves a paper out of anywhere else |
| `remove_from_collection` | `items[]`, `collection` | Drops the folder membership. The papers stay in the library |
| `manage_tags` | `action`, `tag`, `new_tag`, `items[]` | `add`, `remove` (from given items, or from every item that has the tag), or `rename` across the library |

### Deleting (web API, needs a key, separate setting)

| Tool | Parameters | Effect |
| --- | --- | --- |
| `delete_items` | `items[]`, `action` | `trash` moves items to Zotero's Trash, recoverable there for 30 days. `restore` brings them back. Identify trashed items by key, since they leave the search index |
| `delete_collection` | `collection`, `include_subcollections` | Deletes the folder and leaves its papers in the library. Refuses on a folder with subfolders unless the flag is set |

### History

| Tool | Parameters | Effect |
| --- | --- | --- |
| `list_recent_changes` | `limit` | The journal, newest first, with change IDs and whether each was undone |
| `undo_changes` | `change_ids[]` or `last_n` | Reverses changes newest-first, applying each one's recorded inverse |

## How it works

Reads and writes take different routes, for a reason.

**Reads** go to Zotero's local API at `127.0.0.1:23119`. That endpoint sees the whole library
regardless of your storage quota, reads Zotero's own full-text index, and can point at PDFs on disk.
A hosted server could only see what has synced to zotero.org, which on the free plan is frequently
not the PDFs, so `read_paper` and full-text search would mostly stop working. This is why the tool
is local-first and needs Zotero open.

**Writes** go to the Zotero web API, because the local API is read-only. They need a key, and they
reach your desktop app on its next sync, usually within seconds.

**Every write is journaled** to `~/.zotero-claude-connector/journal.jsonl` before it is considered
done. Each entry holds the operations performed and their exact inverses, which is what makes undo
real rather than a best guess. Collection deletion captures the whole subtree, its nesting and its
membership, before removing anything, so undo rebuilds the folders and refiles every paper.

**Every request has a deadline.** The transport in `server/http.js` opens a fresh connection per
request and times out on connect, headers, and body read. Reads retry once; writes never retry
automatically, so a change cannot be applied twice. This exists because Node's global `fetch` pools
keep-alive sockets with no response deadline, and a stale socket to a long-running Zotero would hang
indefinitely. See the [changelog](CHANGELOG.md) for the full account.

## Safety model

- Item records are never edited. Titles, authors, dates, and abstracts are read-only.
- Nothing is erased permanently. Trashed items sit in Zotero's Trash, recoverable there for 30 days.
  Emptying the trash is left to you, in Zotero. Deleting a collection leaves its papers in the
  library.
- Deleting a collection that has subcollections is refused unless you explicitly ask for the branch,
  so a whole tree never disappears by accident.
- Write tools default to propose-then-confirm. Saying "go ahead without asking" in a chat covers
  filing and tagging, and deliberately does not cover deletion, which is confirmed every time.
- Undo recreates deleted folders, restores their nesting, and refiles the papers that were in them.
- Your API key is stored by Claude Desktop and passed to the server as an environment variable. It
  is never written to disk by this code and never leaves your machine except to api.zotero.org.

## Requirements and limits

- Claude Desktop, and Zotero open on the same computer. This is a local-first design. Reads go to
  Zotero's local API, which is why full text and PDFs on disk are available at all; a hosted version
  would only see what has synced to zotero.org, which on the free storage plan is often not the PDFs.
- Full text comes from Zotero's own index. A scanned PDF that Zotero has not OCR'd has no indexed
  text, and the connector hands Claude the file's path instead.
- Highlights made in external readers such as Preview or Adobe are not in Zotero's database and
  cannot be retrieved.
- Writes go through zotero.org and appear in the desktop app on its next sync, usually within
  seconds.

## Troubleshooting

**"Zotero accepted the connection but sent no reply."** Quit Zotero and open it again. Nothing was
changed. Zotero's local API can stop answering after the app has been open for a long stretch; the
connector detects this and gives up rather than hanging. Ask for "check my Zotero connection status"
to confirm it is back, and watch the reported response time. A local call should answer in tens of
milliseconds, so a figure creeping into the thousands is an early warning.

**Timeouts on genuinely large requests.** Raise "Seconds to wait for Zotero" in the extension
settings. The default is 20 seconds for ordinary calls and 60 for full-text reads and exports.

**"This operation needs a Zotero API key."** You are trying to organize without a key configured.
See step 4 of Install, or just ask Claude to read instead.

## Building from source

```bash
git clone https://github.com/merylye/zotero-claude-connector.git
cd zotero-claude-connector
npm install
npm test
./scripts/build-mcpb.sh
```

The build writes `dist/zotero-connector-<version>.mcpb`. Requires Node 18 or newer and `zip`.

## Development

```
server/index.js    MCP tool definitions and the write/undo plumbing
server/zotero.js   local API and web API clients, collection and item resolution
server/http.js     HTTP transport: per-request deadlines, no socket reuse, retry on reads
server/journal.js  the on-disk change journal
test/              a mock Zotero (local + web API) and an end-to-end suite over stdio
```

`npm test` spins up the mock Zotero on ports 23119 and 8123, connects a real MCP client to the
server over stdio, and exercises every tool, including deletion, undo, and a server that accepts
connections and never answers.

Anything that writes to a real library should be added as a journaled primitive with an exact
inverse, in `applyPrimitive` and `inverseOf`. That is what keeps undo honest.

## License

MIT. See [LICENSE](LICENSE), and the disclaimer above.
