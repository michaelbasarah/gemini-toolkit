import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { chunkText, cosine, sourceHash, ensureIndexed, retrieve, answer, buildContext } from "../src/rag.mjs";
import { fakeEmbed, countingEmbed } from "./helpers.mjs";

const cfg = { model: "m", dim: 10 };
const docs = () => [
  { source: "returns.md", title: "Returns", content: "You can get a refund within 30 days. Return it unused." },
  { source: "shipping.md", title: "Shipping", content: "Delivery takes 3 days. Shipping is free over 75." },
  { source: "warranty.md", title: "Warranty", content: "A tent has a 5 year warranty." },
];

test("chunkText packs paragraphs, splits at maxChars, hard-wraps with overlap", () => {
  assert.equal(chunkText("para1\n\npara2").length, 1);
  assert.deepEqual(chunkText("para1\n\npara2", { maxChars: 5, overlap: 0 }), ["para1", "para2"]);
  assert.deepEqual(chunkText("   "), []);
  const w = chunkText("abcdefghij", { maxChars: 4, overlap: 1 });
  assert.equal(w[0], "abcd");
  assert.ok(w.length >= 3);
});

test("cosine", () => {
  assert.equal(Math.round(cosine([1, 2, 3], [1, 2, 3])), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test("sourceHash is stable and sensitive to content and embedding params", () => {
  const d = { title: "T", content: "x" };
  assert.equal(sourceHash(d, cfg), sourceHash({ ...d }, cfg));
  assert.notEqual(sourceHash(d, cfg), sourceHash({ ...d, content: "y" }, cfg));
  assert.notEqual(sourceHash(d, cfg), sourceHash(d, { ...cfg, dim: 768 }));
  assert.notEqual(sourceHash(d, cfg), sourceHash(d, { ...cfg, model: "other" }));
});

test("hash gate: second run embeds nothing; an edit re-embeds only that file; deletions are dropped", async () => {
  const db = openDb(":memory:");
  const embed = countingEmbed();
  const run = (d, o = {}) => ensureIndexed(db, d, { embed, ...cfg, ...o });

  const r1 = await run(docs());
  assert.deepEqual([r1.added, r1.chunks, r1.embedded], [3, 3, 3]);

  embed.texts = 0;
  const r2 = await run(docs());
  assert.deepEqual([r2.unchanged, r2.embedded, embed.texts], [3, 0, 0]);

  const edited = docs();
  edited[0].content = "Refunds now take 60 days.";
  embed.texts = 0;
  const r3 = await run(edited);
  assert.deepEqual([r3.updated, r3.unchanged, embed.texts], [1, 2, 1]);

  const r4 = await run(docs().slice(0, 2));
  assert.equal(r4.removed, 1);
  assert.equal(r4.chunks, 2);

  embed.texts = 0;
  const r5 = await run(docs().slice(0, 2), { force: true });
  assert.equal(embed.texts, 2, "force re-embeds even when unchanged");
});

test("collections are isolated", async () => {
  const db = openDb(":memory:");
  await ensureIndexed(db, docs(), { embed: fakeEmbed, ...cfg, collection: "a" });
  assert.equal((await retrieve(db, "refund", { embed: fakeEmbed, collection: "b" })).length, 0);
  assert.ok((await retrieve(db, "refund", { embed: fakeEmbed, collection: "a" })).length > 0);
});

test("retrieve ranks the relevant source first and returns BLOB vectors intact", async () => {
  const db = openDb(":memory:");
  await ensureIndexed(db, docs(), { embed: fakeEmbed, ...cfg });
  const hits = await retrieve(db, "can I get a refund?", { embed: fakeEmbed, k: 2 });
  assert.equal(hits[0].source, "returns.md");
  assert.ok(hits[0].score > 0.5);
  assert.equal(hits.length, 2);
  assert.equal((await retrieve(db, "tent warranty", { embed: fakeEmbed, k: 1 }))[0].source, "warranty.md");
  assert.deepEqual(await retrieve(db, "  ", { embed: fakeEmbed }), []);
});

test("answer passes numbered context to the model and returns sources; empty index is a clear message", async () => {
  const db = openDb(":memory:");
  let seen;
  const gemini = { embed: fakeEmbed, generateText: async (a) => { seen = a; return " Thirty days [1]. "; } };
  const empty = await answer(db, "refund?", { gemini });
  assert.match(empty.answer, /index/i);
  assert.equal(seen, undefined, "no model call when nothing is indexed");

  await ensureIndexed(db, docs(), { embed: fakeEmbed, ...cfg });
  const r = await answer(db, "refund?", { gemini, k: 1 });
  assert.equal(r.answer, "Thirty days [1].");
  assert.equal(r.sources[0].source, "returns.md");
  assert.match(seen.contents, /\[1\] \(returns\.md\)/);
  assert.match(seen.system, /ONLY/);
  assert.match(buildContext([{ source: "s", content: " c " }]), /^\[1\] \(s\)\nc$/);
});
