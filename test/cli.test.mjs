import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { run } from "../src/cli.mjs";
import { fakeEmbed } from "./helpers.mjs";

const demo = new URL("../demo/docs", import.meta.url).pathname;
const menu = new URL("../demo/sample-menu.pdf", import.meta.url).pathname;

function harness(extra = {}) {
  const db = openDb(":memory:");
  const lines = [], errs = [];
  const gemini = {
    embed: fakeEmbed, embedModel: "fake", dim: 10,
    generateText: async () => "30 days [1]",
    generateJson: async () => ({ items: [{ name: "Oyster stew", price: "$0.50", confidence: 0.9 }, { name: "Vanilla ice cream", price: "", confidence: 0.3 }] }),
    uploadFile: async () => { throw new Error("unused"); },
    ...extra,
  };
  return { db, lines, errs, deps: { db, gemini, out: (s) => lines.push(s), err: (s) => errs.push(s) } };
}

test("index then ask over the demo folder, end to end with fakes", async () => {
  const h = harness();
  assert.equal(await run(["index", demo], h.deps), 0);
  assert.match(h.lines[0], /5 files: 5 new, 0 changed, 0 unchanged/);
  assert.equal(await run(["index", demo], h.deps), 0);
  assert.match(h.lines[1], /5 unchanged.*0 chunks embedded/);

  assert.equal(await run(["ask", "return", "for", "a", "refund"], h.deps), 0);
  assert.match(h.lines.at(-2), /30 days/);
  assert.match(h.lines.at(-1), /Sources: \[1\] returns\.md/);

  assert.equal(await run(["ask", "tent warranty", "--chunks", "-k", "1"], h.deps), 0);
  assert.match(h.lines.at(-1), /warranty\.md/);
});

test("usage prints a report and --json is valid JSON", async () => {
  const h = harness();
  assert.equal(await run(["usage", "daily"], h.deps), 0);
  assert.match(h.lines[0], /DAILY/);
  assert.equal(await run(["usage", "--json"], h.deps), 0);
  assert.equal(JSON.parse(h.lines[1]).window, "all");
  assert.equal(await run(["usage", "yearly"], h.deps), 2);
});

test("menu vision mode prints JSON and a review summary", async () => {
  const h = harness();
  assert.equal(await run(["menu", menu], h.deps), 0);
  const j = JSON.parse(h.lines[0]);
  assert.equal(j.mode, "vision");
  assert.deepEqual(j.items.map((i) => i.needsReview), [false, true]);
  assert.match(h.errs.at(-1), /2 items, 1 need review/);
});

test("menu --text uses the PDF text layer (skipped without pdfjs-dist)", async (t) => {
  try { await import("pdfjs-dist/legacy/build/pdf.mjs"); } catch { return t.skip("pdfjs-dist not installed"); }
  let seen;
  const h = harness({ generateJson: async (a) => { seen = a; return { items: [] }; } });
  assert.equal(await run(["menu", menu, "--text"], h.deps), 0);
  assert.match(seen.contents, /Oyster stew/);
});

test("bad usage returns exit code 2 or 1, never throws", async () => {
  const h = harness();
  assert.equal(await run([], h.deps), 2);
  assert.equal(await run(["nope"], h.deps), 2);
  assert.equal(await run(["index"], h.deps), 2);
  assert.equal(await run(["index", "/no/such/dir"], h.deps), 2);
  assert.equal(await run(["ask"], h.deps), 2);
  assert.equal(await run(["menu"], h.deps), 2);
  assert.equal(await run(["--bogus"], h.deps), 2);
  assert.equal(await run(["menu", "/no/such/file.pdf"], h.deps), 1);
  assert.equal(await run(["--help"], h.deps), 0);
});
