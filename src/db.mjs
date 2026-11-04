// One SQLite file holds everything: indexed chunks (vectors as BLOBs) and the cost ledger.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DB = ".gemini-toolkit/toolkit.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  collection TEXT NOT NULL,
  source     TEXT NOT NULL,
  hash       TEXT NOT NULL,
  chunks     INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (collection, source)
);
CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  collection  TEXT NOT NULL,
  source      TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  vector      BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_by_source ON chunks (collection, source);
CREATE TABLE IF NOT EXISTS llm_usage (
  id           INTEGER PRIMARY KEY,
  created_at   TEXT NOT NULL,
  tag          TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  in_tokens    INTEGER NOT NULL,
  out_tokens   INTEGER NOT NULL,
  cache_tokens INTEGER NOT NULL,
  cost_usd     REAL NOT NULL,
  priced       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_by_time ON llm_usage (created_at);
`;

/** Open (and create if needed) the toolkit database. Pass ":memory:" in tests. */
export function openDb(path = process.env.GT_DB || DEFAULT_DB) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; roll back if it throws. */
export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
