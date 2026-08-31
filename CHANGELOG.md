# Changelog

## 1.2.0 (2026-08-29)

### Added
- **`add_items_by_identifier`.** Creates Zotero items from DOIs, arXiv IDs, ISBNs, and URLs, mixed
  freely in one call, optionally filed into a collection and tagged on the way in. Metadata comes
  from `doi.org` content negotiation (CSL-JSON, whichever agency registered the DOI), the arXiv API,
  Open Library with a Google Books fallback, and for a plain URL the page's own `citation_*`,
  Dublin Core, and Open Graph meta tags. An arXiv preprint that reports a published DOI is resolved
  through that DOI instead, and a page declaring a `citation_doi` is too, since the version of
  record beats a scraped page every time.
- `dry_run` reports what was found without writing anything, so the metadata can be checked before
  it lands in the library. Duplicates are detected by DOI, then by normalised title, and skipped
  with a note unless `allow_duplicates` is set.
- Items are built against Zotero's published item templates, fetched at runtime, so only fields the
  target item type actually has are sent, and the mapping survives Zotero adding item types.
  Metadata with no home for its type, such as a DOI on a book, goes to `extra`.
- Undo moves created items to the trash rather than erasing them, keeping the guarantee that nothing
  this connector does is irreversible.
- `maxBytes` on the HTTP transport, so fetching a page of unknown size stops after 2MB instead of
  buffering whatever the server sends.

### Validated against the live services
The metadata sources were checked against real responses before release, which caught six mismatches
the mock had hidden. Crossref's CSL transform emits Crossref's own type vocabulary rather than CSL's
(`journal-article`, `proceedings-article`, `monograph`, not `article-journal`, `paper-conference`,
`book`), so three of four test DOIs were falling back to journalArticle. Crossref also says
`publisher-location` where CSL says `publisher-place`; carries the conference name in `event`; puts a
preprint server's name in `institution` rather than `publisher`; returns `container-title` as an empty
array on preprints; and returns abstracts as JATS XML that needs its tags stripped. All six are fixed,
and the test fixtures now mirror the real payload shapes rather than idealised CSL.

### Fixed after a live test
Two more surfaced running real DOIs against a real library. Crossref returns entity-encoded text, so
`AI &amp; SOCIETY` was landing in the publication field verbatim; every string reaching Zotero is now
decoded, named and numeric entities alike. And the `URL` Crossref supplies uses the legacy
`http://dx.doi.org/` form, which is now normalised to `https://doi.org/`.

### Known limits
- URL lookups have none of Zotero's site-specific translators behind them. Publishers and preprint
  servers emit the meta tags this reads; blogs and JavaScript-rendered pages often do not, and those
  fall back to a bare webpage item. Zotero's browser button remains better for arbitrary pages.
- Metadata only. No PDF is downloaded or attached.

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
