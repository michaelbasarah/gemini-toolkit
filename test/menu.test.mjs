import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseMenuResponse, buildContents, resolveMenuFiles, extractMenu, extractMenuFromText, LOW_CONFIDENCE, MENU_SCHEMA,
} from "../src/menu.mjs";
import { extractText, ExtractError } from "../src/pdf-text.mjs";

test("dedup collapses repeats, keeping the copy that carries the price and the higher confidence", () => {
  const out = parseMenuResponse({ items: [
    { name: "Fried smelts", price: "", category: "Fish", confidence: 0.4 },
    { name: "fried  smelts", price: "$0.45", category: "", confidence: 0.9 },
    { name: "FRIED SMELTS", price: "", confidence: 0.3 },
  ] });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].price, out[0].category, out[0].confidence], ["$0.45", "Fish", 0.9]);
});

test("prices are kept verbatim: ranges, per-unit, market price", () => {
  const out = parseMenuResponse({ items: [
    { name: "A", price: "$0.75-$1.10", confidence: 0.8 },
    { name: "B", price: "$0.10/dish", confidence: 0.8 },
    { name: "C", price: "market price", confidence: 0.6 },
  ] });
  assert.deepEqual(out.map((i) => i.price), ["$0.75-$1.10", "$0.10/dish", "market price"]);
});

test("needsReview: no price or low confidence; a confident priced row is clean", () => {
  const [a, b, c] = parseMenuResponse({ items: [
    { name: "A", price: "", confidence: 0.9 },
    { name: "B", price: "5", confidence: LOW_CONFIDENCE },
    { name: "C", price: "5", confidence: 0.95 },
  ] });
  assert.deepEqual([a.needsReview, b.needsReview, c.needsReview], [true, true, false]);
});

test("normalisation: default/clamped confidence, nameless rows dropped, junk input safe", () => {
  assert.equal(parseMenuResponse({ items: [{ name: "Tea" }] })[0].confidence, 0.5);
  assert.equal(parseMenuResponse({ items: [{ name: "X", confidence: 5 }] })[0].confidence, 1);
  assert.equal(parseMenuResponse({ items: [{ name: "X", confidence: -2 }] })[0].confidence, 0);
  assert.equal(parseMenuResponse({ items: [{ price: "1", confidence: 1 }] }).length, 0);
  assert.deepEqual(parseMenuResponse(null), []);
  assert.equal(parseMenuResponse([{ name: "Bare", confidence: 0.7 }]).length, 1);
});

test("buildContents: inline and uploaded parts, empty skipped, text cue last", () => {
  const c = buildContents([{ mimeType: "application/pdf", data: "QUJD" }, { data: "" }, { mimeType: "application/pdf", fileUri: "files/x" }]);
  assert.equal(c[0].parts.length, 3);
  assert.deepEqual(c[0].parts[0].inlineData, { mimeType: "application/pdf", data: "QUJD" });
  assert.deepEqual(c[0].parts[1].fileData, { fileUri: "files/x", mimeType: "application/pdf" });
  assert.ok(c[0].parts[2].text);
});

test("resolveMenuFiles: inline when small, upload when over budget, skip when huge or unsupported", () => {
  const MB = 1024 * 1024;
  const { files, skipped } = resolveMenuFiles([
    { name: "dir/big.pdf", buffer: Buffer.alloc(13 * MB, 1) },
    { name: "small.png", buffer: Buffer.from("x") },
    { name: "huge.pdf", buffer: Buffer.alloc(46 * MB, 1) },
    { name: "notes.txt", buffer: Buffer.from("x") },
    { name: "empty.jpg", buffer: Buffer.alloc(0) },
  ]);
  assert.deepEqual(files.map((f) => [f.name, f.kind]), [["big.pdf", "upload"], ["small.png", "inline"]]);
  assert.ok(Buffer.isBuffer(files[0].buffer) && !files[0].data);
  assert.equal(files[1].data, Buffer.from("x").toString("base64"));
  assert.equal(skipped.length, 3);
});

test("resolveMenuFiles caps the number of files", () => {
  const f = (n) => ({ name: n, buffer: Buffer.from("x") });
  const { files, skipped } = resolveMenuFiles([f("1.pdf"), f("2.pdf"), f("3.pdf"), f("4.pdf")]);
  assert.equal(files.length, 3);
  assert.match(skipped[0].reason, /more than/);
});

test("extractMenu calls the model once with schema + prompt, returns parsed items", async () => {
  let seen;
  const gemini = { uploadFile: async () => { throw new Error("unused"); },
    generateJson: async (a) => { seen = a; return { items: [{ name: "Soup", price: "$1", confidence: 0.9 }] }; } };
  const r = await extractMenuOk(gemini);
  assert.equal(r.items[0].name, "Soup");
  assert.equal(seen.schema, MENU_SCHEMA);
  assert.equal(seen.purpose, "menu-extract");
  assert.ok(seen.system.includes("price EMPTY") || seen.system.includes("LEAVE price EMPTY"));
  function extractMenuOk(g) { return extractMenu([{ name: "m.pdf", buffer: Buffer.from("x") }], { gemini: g }); }
});

test("oversize file goes through the Files API as a fileData part; a failed upload is skipped and reported", async () => {
  const big = { name: "big.pdf", buffer: Buffer.alloc(13 * 1024 * 1024, 1) };
  const small = { name: "small.pdf", buffer: Buffer.from("x") };
  let parts;
  const mk = (upload) => ({ uploadFile: upload, generateJson: async (a) => { parts = a.contents[0].parts.map((p) => (p.fileData ? "file" : p.inlineData ? "inline" : "text")); return { items: [{ name: "A", confidence: 1, price: "1" }] }; } });

  const ok = await extractMenu([big, small], { gemini: mk(async () => ({ fileUri: "files/u", mimeType: "application/pdf" })) });
  assert.deepEqual(parts, ["file", "inline", "text"]);
  assert.deepEqual(ok.used, ["big.pdf", "small.pdf"]);

  const failed = await extractMenu([big, small], { gemini: mk(async () => { throw new Error("500"); }) });
  assert.deepEqual(parts, ["inline", "text"]);
  assert.deepEqual(failed.used, ["small.pdf"]);
  assert.match(failed.skipped[0].reason, /upload failed/);
});

test("no readable file: throws and never calls the model", async () => {
  let called = false;
  const gemini = { uploadFile: async () => { throw new Error("x"); }, generateJson: async () => { called = true; return {}; } };
  await assert.rejects(extractMenu([{ name: "big.pdf", buffer: Buffer.alloc(13 * 1024 * 1024, 1) }], { gemini }), /no readable menu file/);
  await assert.rejects(extractMenu([{ name: "a.txt", buffer: Buffer.from("x") }], { gemini }), /unsupported/);
  assert.equal(called, false);
});

test("extractMenuFromText sends the text with the text-mode purpose", async () => {
  let seen;
  const r = await extractMenuFromText("Soup ... $1", { gemini: { generateJson: async (a) => { seen = a; return { items: [{ name: "Soup", price: "$1", confidence: 0.8 }] }; } } });
  assert.equal(r.items.length, 1);
  assert.equal(seen.purpose, "menu-extract-text");
  assert.match(seen.contents, /Soup \.\.\. \$1/);
});

test("extractText: txt ok, empty and unsupported are explicit errors", async () => {
  assert.equal(await extractText("a.md", Buffer.from(" hi \u0000")), "hi");
  await assert.rejects(extractText("a.txt", Buffer.from("  ")), ExtractError);
  await assert.rejects(extractText("a.docx", Buffer.from("x")), /unsupported/);
});

test("extractText reads the sample menu PDF (skipped if pdfjs-dist is not installed)", async (t) => {
  try { await import("pdfjs-dist/legacy/build/pdf.mjs"); } catch { return t.skip("pdfjs-dist not installed"); }
  const text = await extractText("sample-menu.pdf", readFileSync(new URL("../demo/sample-menu.pdf", import.meta.url)));
  assert.match(text, /Oyster stew/);
  assert.match(text, /\$0\.75-\$1\.10/);
});

test("extractText on a non-PDF with a .pdf name is an explicit parse error", async (t) => {
  try { await import("pdfjs-dist/legacy/build/pdf.mjs"); } catch { return t.skip("pdfjs-dist not installed"); }
  await assert.rejects(extractText("bad.pdf", Buffer.from("not a pdf")), /could not parse/);
});
