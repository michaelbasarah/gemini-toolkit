// Menu PDF/photo -> structured JSON for a human to review.
//
// Why vision and not OCR text: on a menu, a dish and its price are paired by LAYOUT (same row, next
// column, a dotted leader line). Flattened OCR loses that and mis-pairs them. Reading the page as an
// image keeps the alignment. A text-only mode exists for PDFs that have a real text layer.
//
// HARD RULE: this module only extracts. It writes nothing. The output is a draft; a wrong guessed
// price is worse than a blank one, so uncertain rows are left empty and flagged `needsReview`.
import { extname, basename } from "node:path";

// At or below this confidence (or with no price) a row is flagged for the reviewer.
export const LOW_CONFIDENCE = 0.6;

// Files whose combined bytes fit MAX_INLINE_BYTES ride inline (base64 inflates ~1.33x against a ~20 MB
// request ceiling). A bigger file is uploaded through the Files API instead of being dropped. Past
// MAX_FILE_BYTES it is skipped so a huge file can't hang the run.
export const MAX_FILES = 3;
export const MAX_INLINE_BYTES = 12 * 1024 * 1024;
export const MAX_FILE_BYTES = 45 * 1024 * 1024;

const MIME = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
export const mimeFor = (name) => MIME[extname(String(name)).toLowerCase()] || "";

export const MENU_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      description: "Every distinct orderable dish, drink or package on the menu, once each.",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "The item name as printed. No price or qualifier in the name." },
          price: { type: "STRING", nullable: true, description: "The price EXACTLY as printed, verbatim: keep ranges ('98K-148K'), per-unit markers ('/portion', '/kg') and currency marks. LEAVE EMPTY when you cannot confidently pair a price to THIS item." },
          category: { type: "STRING", nullable: true, description: "The printed section heading this item sits under. Empty if none is clear." },
          confidence: { type: "NUMBER", description: "0..1, how sure you are the name-to-price pairing is right. Use a LOW value (<0.5) when the price is uncertain, unpaired or left empty." },
        },
        required: ["name", "confidence"],
      },
    },
  },
  required: ["items"],
};

export const EXTRACT_PROMPT = `You extract a restaurant's structured menu from its menu file(s) (PDF pages or images) so a person can review it. Read the LAYOUT visually: a dish name and its price are paired by position (same row, adjacent column, or a leader-dotted line), which flattened OCR text loses.

Return STRICT JSON matching the schema: an "items" array of {name, price, category, confidence}.

RULES:
- One entry PER DISTINCT item. If the same name appears more than once (a repeated line, a page overlap), output it ONCE. If the same name has different prices for different portions ("half" vs "whole"), you MAY output separate entries whose NAME includes the portion, but never the identical name twice.
- PRICE, verbatim: copy it exactly as printed. Keep ranges ("98K-148K"), per-unit markers ("/portion", "/kg", "each") and currency marks ("$", "Rp", "K", "EUR"). Do NOT normalise, round, convert or invent a number.
- UNCERTAIN PAIRING: if a price sits in a separate block and you cannot be SURE it belongs to this item, or a dish has no price near it, LEAVE price EMPTY and set confidence LOW (<0.5). A blank the reviewer fills is far better than a confidently wrong price.
- CATEGORY: the printed section heading the item sits under. Empty if unclear.
- PACKAGES / SET MENUS: include them as items (category "Set menu" or as printed) with the package price.
- SKIP non-items: headings, addresses, phone numbers, opening hours, terms and conditions, decorative text, page numbers.
- SEASONAL / "market price": keep the item, put that phrase in price as printed, confidence moderate.
- Be thorough: capture the WHOLE menu, not just the first page.`;

const CUE = "Extract every orderable item from the attached menu file(s) into the items array.";

/** Gemini `contents` for one call: each file as a vision part (inline or uploaded), then a text cue. Pure. */
export function buildContents(files) {
  const parts = [];
  for (const f of files || []) {
    if (!f?.mimeType) continue;
    if (f.fileUri) parts.push({ fileData: { fileUri: f.fileUri, mimeType: f.mimeType } });
    else if (f.data) parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
  }
  parts.push({ text: CUE });
  return [{ role: "user", parts }];
}

/**
 * Clean and de-duplicate the model's raw response into [{name, price, category, confidence, needsReview}].
 * Dedup is by case/space-insensitive name; on a repeat the copy that carries a price/category wins and
 * the higher confidence is kept. Pure, so it unit-tests against fixtures.
 */
export function parseMenuResponse(raw) {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  const out = [];
  const byName = new Map();
  for (const it of arr) {
    const name = String(it?.name ?? "").trim().replace(/\s+/g, " ");
    if (!name) continue;
    const price = String(it?.price ?? "").trim();
    const category = String(it?.category ?? "").trim();
    let confidence = Number(it?.confidence);
    confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5;
    const key = name.toLowerCase();
    if (byName.has(key)) {
      const ex = out[byName.get(key)];
      if (!ex.price && price) ex.price = price;
      if (!ex.category && category) ex.category = category;
      ex.confidence = Math.max(ex.confidence, confidence);
      continue;
    }
    byName.set(key, out.length);
    out.push({ name, price, category, confidence });
  }
  for (const r of out) r.needsReview = !r.price || r.confidence <= LOW_CONFIDENCE;
  return out;
}

/**
 * Classify files for the request: inline (base64) while the inline budget lasts, "upload" beyond it,
 * skipped past the per-file ceiling. `files` is [{name, buffer}]. Pure.
 * Returns { files, skipped }.
 */
export function resolveMenuFiles(files) {
  const out = [];
  const skipped = [];
  let inlineTotal = 0;
  for (const f of files) {
    const mimeType = mimeFor(f.name);
    const name = basename(f.name);
    if (!mimeType) { skipped.push({ name, reason: "unsupported type (use .pdf, .png, .jpg, .webp)" }); continue; }
    if (!f.buffer?.length) { skipped.push({ name, reason: "empty file" }); continue; }
    if (out.length >= MAX_FILES) { skipped.push({ name, reason: `more than ${MAX_FILES} files` }); continue; }
    if (f.buffer.length > MAX_FILE_BYTES) { skipped.push({ name, reason: "too large to upload" }); continue; }
    if (inlineTotal + f.buffer.length <= MAX_INLINE_BYTES) {
      inlineTotal += f.buffer.length;
      out.push({ name, mimeType, kind: "inline", data: f.buffer.toString("base64") });
    } else {
      out.push({ name, mimeType, kind: "upload", buffer: f.buffer });
    }
  }
  return { files: out, skipped };
}

/** Turn resolved files into request parts. A failed upload is dropped (and reported), not fatal. */
async function prepare(files, uploadFile) {
  const ready = [];
  const failed = [];
  for (const f of files) {
    if (f.kind === "upload") {
      try {
        const up = await uploadFile({ buffer: f.buffer, mimeType: f.mimeType, displayName: f.name });
        ready.push({ name: f.name, mimeType: up.mimeType || f.mimeType, fileUri: up.fileUri });
      } catch (e) {
        failed.push({ name: f.name, reason: `upload failed: ${e?.message || e}` });
      }
    } else ready.push(f);
  }
  return { ready, failed };
}

/**
 * Vision extraction. `gemini` is the object from createGemini (generateJson + uploadFile), or any fake
 * with the same two methods. Throws when no file survived preparation, so Gemini is never called with
 * no menu attached. Returns { items, used, skipped }.
 */
export async function extractMenu(files, { gemini }) {
  const { files: resolved, skipped } = resolveMenuFiles(files);
  const { ready, failed } = await prepare(resolved, gemini.uploadFile);
  if (!ready.length) {
    const why = [...skipped, ...failed].map((s) => `${s.name}: ${s.reason}`).join("; ");
    throw new Error(`no readable menu file${why ? ` (${why})` : ""}`);
  }
  const raw = await gemini.generateJson({ system: EXTRACT_PROMPT, contents: buildContents(ready), schema: MENU_SCHEMA, purpose: "menu-extract" });
  return { items: parseMenuResponse(raw), used: ready.map((f) => f.name), skipped: [...skipped, ...failed] };
}

/** Text-only mode for PDFs that have a real text layer: same schema, no vision. Returns { items }. */
export async function extractMenuFromText(text, { gemini }) {
  const raw = await gemini.generateJson({
    system: EXTRACT_PROMPT + "\nThe menu arrives as flattened text, so layout is lost: when pairing is unclear, leave price empty with LOW confidence.",
    contents: `${CUE}\n\n${text}`,
    schema: MENU_SCHEMA,
    purpose: "menu-extract-text",
  });
  return { items: parseMenuResponse(raw) };
}
