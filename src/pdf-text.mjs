// Server-side text extraction with an honest failure mode: either you get text, or you get an error that
// says what to do instead. pdfjs-dist is an optional dependency, imported lazily, so a missing install
// degrades to a clear message rather than a crash at load time.
import { extname } from "node:path";

export class ExtractError extends Error {
  constructor(message, code) { super(message); this.name = "ExtractError"; this.code = code; }
}

const MAX_PDF_PAGES = Number(process.env.GT_MAX_PDF_PAGES) || 300;
export const TEXT_EXT = new Set([".md", ".markdown", ".txt"]);

/** Plain text from .md/.txt/.pdf bytes. Throws ExtractError with an actionable message. */
export async function extractText(name, buffer) {
  const ext = extname(String(name)).toLowerCase();
  if (TEXT_EXT.has(ext)) {
    const text = buffer.toString("utf8").replace(/\u0000/g, "").trim();
    if (!text) throw new ExtractError(`${name} is empty`, "empty");
    return text;
  }
  if (ext === ".pdf") return extractPdf(name, buffer);
  throw new ExtractError(`${name}: unsupported type (use .md, .txt or .pdf)`, "type");
}

async function extractPdf(name, buffer) {
  let getDocument;
  try {
    ({ getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs"));
  } catch {
    throw new ExtractError(`${name}: PDF text needs pdfjs-dist (npm install pdfjs-dist), or export the PDF to .txt first`, "lib");
  }
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
    const parts = [];
    for (let p = 1; p <= Math.min(doc.numPages, MAX_PDF_PAGES); p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      parts.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    }
    const text = parts.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    // No text layer means a scan or a photo. Say so rather than index nothing.
    if (!text) throw new ExtractError(`${name}: no text layer (a scan or image-only PDF). Use vision mode, or paste the text`, "empty");
    return text;
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(`${name}: could not parse (corrupt or password-protected?)`, "parse");
  } finally {
    try { await doc?.destroy?.(); } catch { /* best effort */ }
  }
}
