// journal.js — on-disk change journal so every write Claude makes is reviewable and reversible.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = process.env.ZOTERO_CONNECTOR_DATA_DIR || path.join(os.homedir(), ".zotero-claude-connector");
const FILE = path.join(DIR, "journal.jsonl");

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

export function journalPath() {
  return FILE;
}

export function appendEntry(entry) {
  ensureDir();
  const id = `chg_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const full = { id, ts: new Date().toISOString(), undone: false, ...entry };
  fs.appendFileSync(FILE, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function readEntries() {
  ensureDir();
  if (!fs.existsSync(FILE)) return [];
  return fs
    .readFileSync(FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function markUndone(ids) {
  const entries = readEntries();
  const idSet = new Set(ids);
  const updated = entries.map((e) => (idSet.has(e.id) ? { ...e, undone: true } : e));
  fs.writeFileSync(FILE, updated.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
