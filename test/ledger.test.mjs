import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.mjs";
import {
  cost, rateFor, loadRates, record, recordGemini, recordEmbedding, usageReport, formatReport,
  sinceDaysAgo, spendToday, assertWithinBudget, BudgetExceeded,
} from "../src/ledger.mjs";
import { createGemini, withRetry, EMBED_BATCH } from "../src/gemini.mjs";
import { fakeClient } from "./helpers.mjs";

test("cost math per 1M tokens, cache priced separately", () => {
  assert.equal(cost("gemini-2.5-flash", { inTokens: 1e6 }), 0.5);
  assert.equal(cost("gemini-2.5-flash", { outTokens: 1e6 }), 2);
  assert.equal(cost("gemini-2.5-flash", { cacheTokens: 1e6 }), 0.125);
  assert.equal(cost("gemini-embedding-001", { inTokens: 1e6 }), 0.15);
});

test("unknown model is null (not guessed); dated suffix matches, a sibling model does not", () => {
  assert.equal(cost("mystery-model", { inTokens: 5 }), null);
  assert.ok(rateFor("gemini-2.5-flash-preview-09-2025"));
  assert.equal(rateFor("gemini-2.5-flash-lite"), null);
});

test("GT_RATES file merges over defaults", () => {
  const f = join(mkdtempSync(join(tmpdir(), "gt-")), "rates.json");
  writeFileSync(f, JSON.stringify({ "gemini-2.5-flash": { in: 1, out: 1, cache: 0 }, "my-model": { in: 2 } }));
  const r = loadRates(f);
  assert.equal(r["gemini-2.5-flash"].in, 1);
  assert.equal(r["my-model"].in, 2);
  assert.ok(r["gemini-embedding-001"]);
  assert.equal(r._note, undefined);
});

test("recordGemini splits cached tokens out of the prompt and bills thinking as output", () => {
  const db = openDb(":memory:");
  const usd = recordGemini(db, { tag: "t", purpose: "p", model: "gemini-2.5-flash",
    usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 100, thoughtsTokenCount: 50 } });
  const row = db.prepare("SELECT * FROM llm_usage").get();
  assert.equal(row.in_tokens, 600);
  assert.equal(row.cache_tokens, 400);
  assert.equal(row.out_tokens, 150);
  assert.ok(Math.abs(usd - (600 * 0.5 + 150 * 2 + 400 * 0.125) / 1e6) < 1e-12);
});

test("report groups by tag/model/purpose and flags unpriced calls", () => {
  const db = openDb(":memory:");
  recordGemini(db, { tag: "a", purpose: "answer", model: "gemini-2.5-flash", usageMetadata: { promptTokenCount: 1e6 } });
  recordEmbedding(db, { tag: "a", purpose: "rag-index", model: "gemini-embedding-001", tokens: 1e6 });
  record(db, { tag: "b", model: "mystery", purpose: "x", inTokens: 10 });
  const rep = usageReport(db, "all");
  assert.equal(rep.calls, 3);
  assert.ok(Math.abs(rep.cost_usd - 0.65) < 1e-9);
  assert.equal(rep.unpriced_calls, 1);
  assert.equal(rep.by.tag[0].key, "a");
  assert.equal(rep.by.purpose.length, 3);
  assert.match(formatReport(rep), /no rate/);
  assert.throws(() => usageReport(db, "yearly"), /unknown window/);
});

test("windows: daily excludes yesterday", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO llm_usage (created_at, tag, provider, model, purpose, in_tokens, out_tokens, cache_tokens, cost_usd, priced) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(new Date(Date.now() - 2 * 864e5).toISOString(), "old", "gemini", "gemini-2.5-flash", "x", 1, 1, 0, 9, 1);
  record(db, { model: "gemini-2.5-flash", inTokens: 1e6 });
  assert.equal(usageReport(db, "daily").calls, 1);
  assert.equal(usageReport(db, "weekly").calls, 2);
  assert.equal(sinceDaysAgo(1, new Date("2026-05-10T15:00:00Z")), "2026-05-10T00:00:00.000Z");
});

test("budget guard: no cap = no check; cap blocks once reached", () => {
  const db = openDb(":memory:");
  record(db, { model: "gemini-2.5-flash", inTokens: 1e6 }); // $0.50
  assert.equal(spendToday(db), 0.5);
  assertWithinBudget(db, 0);
  assertWithinBudget(db, 1);
  assert.throws(() => assertWithinBudget(db, 0.5), BudgetExceeded);
});

test("createGemini: embeds in batches of 100, logs each call, normalises", async () => {
  const db = openDb(":memory:");
  const client = fakeClient();
  const g = await createGemini({ db, client, tag: "t" });
  const out = await g.embed(Array.from({ length: 250 }, (_, i) => "x" + i));
  assert.equal(out.length, 250);
  assert.deepEqual(client.calls.embed.map((c) => c.contents.length), [EMBED_BATCH, EMBED_BATCH, 50]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM llm_usage").get().n, 3);
  const norm = Math.sqrt([...out[0]].reduce((a, x) => a + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6);
  assert.equal(db.prepare("SELECT purpose FROM llm_usage").get().purpose, "rag-index");
});

test("createGemini: generateText/Json log usage with purpose; budget stops the next call", async () => {
  const db = openDb(":memory:");
  const g = await createGemini({ db, client: fakeClient({ text: '{"ok":true}' }) });
  assert.deepEqual(await g.generateJson({ system: "s", contents: "c", schema: {}, purpose: "menu-extract" }), { ok: true });
  assert.equal(db.prepare("SELECT purpose FROM llm_usage").get().purpose, "menu-extract");
  process.env.GT_DAILY_BUDGET_USD = "0.0000001";
  try { await assert.rejects(g.generateText({ system: "s", contents: "c" }), BudgetExceeded); }
  finally { delete process.env.GT_DAILY_BUDGET_USD; }
});

test("createGemini without a key or client fails loudly", async () => {
  await assert.rejects(createGemini({ db: openDb(":memory:"), apiKey: "" }), /GEMINI_API_KEY/);
});

test("withRetry retries 503 then succeeds, but not a 400", async () => {
  let n = 0;
  const r = await withRetry(async () => { if (++n < 3) throw Object.assign(new Error("busy"), { status: 503 }); return "ok"; }, { sleep: async () => {} });
  assert.equal(r, "ok");
  let m = 0;
  await assert.rejects(withRetry(async () => { m++; throw Object.assign(new Error("bad"), { status: 400 }); }, { sleep: async () => {} }));
  assert.equal(m, 1);
});
