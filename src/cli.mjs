// CLI for both tools. `run(argv, deps)` is the whole program; bin/ files only call it, so tests can
// drive it with fakes and no network.
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { openDb } from "./db.mjs";
import { createGemini } from "./gemini.mjs";
import { ensureIndexed, retrieve, answer } from "./rag.mjs";
import { loadFolder } from "./folder.mjs";
import { formatReport, usageReport, WINDOWS } from "./ledger.mjs";
import { extractMenu, extractMenuFromText, LOW_CONFIDENCE } from "./menu.mjs";
import { extractText } from "./pdf-text.mjs";

const HELP = `gemini-toolkit: RAG over SQLite with a cost ledger, plus menu extraction

  gemini-toolkit index <folder> [--collection NAME] [--force]
  gemini-toolkit ask "<question>" [--collection NAME] [-k N] [--chunks]
  gemini-toolkit usage [daily|weekly|monthly|all] [--json]
  gemini-toolkit menu <file...> [--text] [--out items.json]     (also: menu-extract <file...>)

Needs GEMINI_API_KEY (see .env.example). Everything lives in one SQLite file (GT_DB).`;

const OPTS = {
  collection: { type: "string", default: "default" },
  force: { type: "boolean", default: false },
  k: { type: "string", short: "k" },
  chunks: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  text: { type: "boolean", default: false },
  out: { type: "string", short: "o" },
  help: { type: "boolean", short: "h", default: false },
};

/**
 * deps (all optional, for tests): { db, gemini, out(line), err(line) }
 * Returns a process exit code.
 */
export async function run(argv, deps = {}) {
  const out = deps.out || ((s) => console.log(s));
  const err = deps.err || ((s) => console.error(s));
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTS, allowPositionals: true });
  } catch (e) {
    err(e.message);
    return 2;
  }
  const { values: v, positionals: [cmd, ...rest] } = parsed;
  if (!cmd || v.help || cmd === "help") { out(HELP); return cmd || v.help ? 0 : 2; }

  const db = deps.db || openDb();
  const getGemini = async (tag) => deps.gemini || createGemini({ db, tag });
  try {
    if (cmd === "index") {
      const dir = rest[0];
      if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) { err("usage: gemini-toolkit index <folder>"); return 2; }
      const { docs, skipped } = await loadFolder(dir);
      for (const s of skipped) err(`skipped ${s.source}: ${s.reason}`);
      if (!docs.length) { err("no .md / .txt / .pdf files with text found"); return 1; }
      const g = await getGemini(v.collection);
      const s = await ensureIndexed(db, docs, { collection: v.collection, embed: g.embed, model: g.embedModel, dim: g.dim, force: v.force });
      out(`${docs.length} files: ${s.added} new, ${s.updated} changed, ${s.unchanged} unchanged, ${s.removed} removed. ${s.embedded} chunks embedded, ${s.chunks} stored.`);
      return 0;
    }

    if (cmd === "ask") {
      const q = rest.join(" ").trim();
      if (!q) { err('usage: gemini-toolkit ask "<question>"'); return 2; }
      const g = await getGemini(v.collection);
      const k = v.k ? Number(v.k) : undefined;
      if (v.chunks) {
        for (const h of await retrieve(db, q, { collection: v.collection, k, embed: g.embed })) out(`${h.score.toFixed(3)}  ${h.source}\n  ${h.content.replace(/\s+/g, " ").slice(0, 160)}`);
        return 0;
      }
      const r = await answer(db, q, { gemini: g, collection: v.collection, k });
      out(r.answer);
      if (r.sources.length) out("\nSources: " + r.sources.map((s) => `[${s.n}] ${s.source} (${s.score})`).join(", "));
      return 0;
    }

    if (cmd === "usage") {
      const w = rest[0] || "all";
      if (!WINDOWS[w]) { err("usage: gemini-toolkit usage [daily|weekly|monthly|all] [--json]"); return 2; }
      const rep = usageReport(db, w);
      out(v.json ? JSON.stringify(rep, null, 2) : formatReport(rep));
      return 0;
    }

    if (cmd === "menu") {
      if (!rest.length) { err("usage: menu-extract <menu.pdf|photo.jpg ...> [--text] [--out items.json]"); return 2; }
      const g = await getGemini("menu");
      const files = rest.map((p) => ({ name: p, buffer: readFileSync(p) }));
      let result;
      if (v.text) {
        const text = (await Promise.all(files.map((f) => extractText(f.name, f.buffer)))).join("\n\n");
        result = { ...(await extractMenuFromText(text, { gemini: g })), mode: "text" };
      } else {
        result = { ...(await extractMenu(files, { gemini: g })), mode: "vision" };
      }
      for (const s of result.skipped || []) err(`skipped ${s.name}: ${s.reason}`);
      const review = result.items.filter((i) => i.needsReview);
      err(`${result.items.length} items, ${review.length} need review (no price, or confidence <= ${LOW_CONFIDENCE}). Check them before using this.`);
      const json = JSON.stringify({ mode: result.mode, items: result.items }, null, 2);
      if (v.out) writeFileSync(v.out, json + "\n"); else out(json);
      return 0;
    }

    err(`unknown command "${cmd}"\n\n${HELP}`);
    return 2;
  } catch (e) {
    err(`error: ${e.message}`);
    return 1;
  } finally {
    if (!deps.db) db.close();
  }
}
