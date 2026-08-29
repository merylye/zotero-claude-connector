# Changelog

## 1.1.0 (2026-08-29)

### Fixed
- **Requests could hang forever.** Every call used Node's global `fetch()`, which pools keep-alive
  sockets and enforces no deadline on a response. A pooled socket to a long-running Zotero could be
  left half-open, and the next request on it would wait indefinitely with no error. Because the MCP
  server process outlives any single chat, the stale pool persisted until Zotero was restarted.
  Replaced with `server/http.js`, which opens a fresh connection per request and carries a hard
  deadline covering connect, headers, and body. Local calls default to 20s, web calls to 30s, and
  full-text reads and whole-collection exports to 60s. Reads retry once; writes never retry
  automatically, so no change can be applied twice. A stall now returns a message naming the fix.
- `check_status` reports the local API's round-trip time, so a degrading Zotero is visible before it
  fails.

### Added
- `delete_items` moves items to Zotero's trash, recoverable there for 30 days, with
  `action: "restore"` to reverse it.
- `delete_collection` deletes a folder and leaves its papers in the library. It refuses on a
  collection with subcollections unless `include_subcollections` is set, and captures the whole
  subtree's names, nesting, and membership before deleting, so undo rebuilds it exactly.
- Separate `enable_deletes` setting, and a configurable local timeout.

## 1.0.0 (2026-08-02)

Initial release. Reading through Zotero's local API, organizing through the web API, and a
journalled undo.
