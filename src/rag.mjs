// RAG with no vector database. Chunks are embedded by Gemini and stored as Float32 BLOBs in SQLite;
// a query is embedded and ranked by brute-force cosine in JS. That is sub-millisecond for the tens to
// low thousands of chunks a folder of notes produces. Past ~100k chunks, reach for a real index.
//
// Re-indexing is hash-gated per source file: unchanged files cost nothing, edited files are re-chunked
// and re-embedded, and files that disappeared are dropped.
import { createHash } from "node:crypto";
import { tx } from "./db.mjs";

const num = (k, d) => Number(process.env[k]) || d;
export const DEFAULTS = {
  chunkChars: () => num("GT_CHUNK_CHARS", 900),
  overlap: () => num("GT_CHUNK_OVERLAP", 150),
  topK: () => num("GT_TOP_K", 5),
};

/** Hard-wrap an over-long block into windows of maxChars, carrying `overlap` chars between them. */
function hardWrap(s, maxChars, overlap) {
  const out = [];
  const step = Math.max(1, maxChars - overlap);
  for (let i = 0; i < s.length; i += step) out.push(s.slice(i, i + maxChars).trim());
  return out.filter(Boolean);
}

/** Split text into chunks: pack blank-line separated paragraphs up to maxChars, hard-wrap giants. */
export function chunkText(text, { maxChars = DEFAULTS.chunkChars(), overlap = DEFAULTS.overlap() } = {}) {
  const clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const pieces = [];
  let buf = "";
  const flush = () => { if (buf.trim()) pieces.push(buf.trim()); buf = ""; };
  for (const p of clean.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
    if (p.length > maxChars) { flush(); pieces.push(...hardWrap(p, maxChars, overlap)); continue; }
    if (buf && buf.length + 2 + p.length > maxChars) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return pieces;
}

/** Cosine similarity, safe for vectors that are not pre-normalised. */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Fingerprint of one source plus everything that changes its vectors (embedding model, dimension,
 * chunking). Change any of them and the source is re-embedded.
 */
export function sourceHash(doc, { model, dim, chunkChars = DEFAULTS.chunkChars(), overlap = DEFAULTS.overlap() }) {
  return createHash("sha256").update(JSON.stringify({ model, dim, chunkChars, overlap, title: doc.title || "", content: doc.content })).digest("hex");
}

const toBlob = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
// Copy out of the row buffer: a BLOB's byteOffset is not guaranteed 4-byte aligned.
const fromBlob = (u8) => new Float32Array(u8.slice().buffer);

/**
 * Bring a collection in line with `docs` ([{source, title, content}]).
 * Returns { added, updated, unchanged, removed, chunks, embedded } where `chunks` is the total now stored.
 */
export async function ensureIndexed(db, docs, { collection = "default", embed, model, dim, force = false } = {}) {
  const known = new Map(db.prepare("SELECT source, hash FROM sources WHERE collection = ?").all(collection).map((r) => [r.source, r.hash]));
  const seen = new Set();
  const todo = [];
  const stats = { added: 0, updated: 0, unchanged: 0, removed: 0, chunks: 0, embedded: 0 };

  for (const d of docs) {
    if (!d.content?.trim()) continue;
    seen.add(d.source);
    const hash = sourceHash(d, { model, dim });
    if (!force && known.get(d.source) === hash) { stats.unchanged++; continue; }
    known.has(d.source) ? stats.updated++ : stats.added++;
    const pieces = chunkText(d.content).map((content, i) => ({ source: d.source, title: d.title || d.source, chunkIndex: i, content }));
    todo.push({ doc: d, hash, pieces });
  }

  // One embedding batch for everything that changed. Prepend the title so a chunk keeps its context.
  const flat = todo.flatMap((t) => t.pieces);
  const vectors = flat.length
    ? await embed(flat.map((c) => `${c.title}\n${c.content}`), { taskType: "RETRIEVAL_DOCUMENT", purpose: "rag-index" })
    : [];
  stats.embedded = flat.length;

  const gone = [...known.keys()].filter((s) => !seen.has(s));
  stats.removed = gone.length;
  const del = db.prepare("DELETE FROM chunks WHERE collection = ? AND source = ?");
  const delSrc = db.prepare("DELETE FROM sources WHERE collection = ? AND source = ?");
  const ins = db.prepare("INSERT INTO chunks (collection, source, chunk_index, title, content, vector) VALUES (?, ?, ?, ?, ?, ?)");
  const upSrc = db.prepare("INSERT OR REPLACE INTO sources (collection, source, hash, chunks, indexed_at) VALUES (?, ?, ?, ?, ?)");
  let k = 0;
  tx(db, () => {
    for (const s of gone) { del.run(collection, s); delSrc.run(collection, s); }
    for (const t of todo) {
      del.run(collection, t.doc.source);
      for (const p of t.pieces) ins.run(collection, p.source, p.chunkIndex, p.title, p.content, toBlob(vectors[k++]));
      upSrc.run(collection, t.doc.source, t.hash, t.pieces.length, new Date().toISOString());
    }
  });
  stats.chunks = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE collection = ?").get(collection).n;
  return stats;
}

/** Top-K chunks for a query: [{source, title, content, score}], best first. */
export async function retrieve(db, query, { collection = "default", k = DEFAULTS.topK(), embed } = {}) {
  if (!String(query || "").trim()) return [];
  const rows = db.prepare("SELECT source, title, content, vector FROM chunks WHERE collection = ?").all(collection);
  if (!rows.length) return [];
  const [qv] = await embed([String(query)], { taskType: "RETRIEVAL_QUERY", purpose: "rag-query" });
  return rows
    .map((r) => ({ source: r.source, title: r.title, content: r.content, score: cosine(qv, fromBlob(r.vector)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export const ANSWER_SYSTEM = `Answer the question using ONLY the numbered context passages. Cite the passages you used like [1] or [2][3]. If the context does not contain the answer, say you don't know instead of guessing. Be concise.`;

/** Render hits as the numbered context block the model sees. */
export function buildContext(hits) {
  return hits.map((h, i) => `[${i + 1}] (${h.source})\n${h.content.trim()}`).join("\n\n");
}

/** Retrieve, then ask Gemini to answer from the hits. Returns { answer, sources }. */
export async function answer(db, question, { gemini, collection, k } = {}) {
  const hits = await retrieve(db, question, { collection, k, embed: gemini.embed });
  if (!hits.length) return { answer: "Nothing is indexed yet. Run `gemini-toolkit index <folder>` first.", sources: [] };
  const text = await gemini.generateText({
    system: ANSWER_SYSTEM,
    contents: `Context:\n${buildContext(hits)}\n\nQuestion: ${question}`,
    purpose: "rag-answer",
  });
  return { answer: text.trim(), sources: hits.map((h, i) => ({ n: i + 1, source: h.source, score: Number(h.score.toFixed(3)) })) };
}
