// Read a folder of notes into [{source, title, content}] for the indexer.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { extractText, ExtractError } from "./pdf-text.mjs";

const EXTS = new Set([".md", ".markdown", ".txt", ".pdf"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

/** The first "# Heading" if there is one, else the file name without its extension. */
export function titleOf(text, file) {
  return text.match(/^#\s+(.+)$/m)?.[1].trim() || basename(file, extname(file));
}

/** Load every .md/.txt/.pdf under `dir`. Unreadable files are reported in `skipped`, never silently lost. */
export async function loadFolder(dir) {
  const docs = [];
  const skipped = [];
  for (const file of walk(dir)) {
    const source = relative(dir, file).split("\\").join("/");
    try {
      const content = await extractText(file, readFileSync(file));
      docs.push({ source, title: titleOf(content, file), content });
    } catch (e) {
      if (!(e instanceof ExtractError)) throw e;
      skipped.push({ source, reason: e.message });
    }
  }
  return { docs, skipped };
}
