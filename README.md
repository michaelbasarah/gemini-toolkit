# gemini-toolkit

Two small Gemini tools in plain Node, sharing one SQLite file and one cost ledger:

1. **RAG over SQLite.** Ask questions of a folder of notes. No vector database: Gemini embeddings sit
   in SQLite as BLOBs, retrieval is brute-force cosine in JS, and re-indexing only touches files whose
   hash changed. Every model call is priced and logged, so you can see what it cost.
2. **menu-extract.** A restaurant menu (PDF or photo) becomes structured JSON
   `{name, price, category, confidence}` for a person to review. Uncertain rows are left blank and
   flagged instead of guessed.

Runtime dependencies: `@google/genai`, plus optional `pdfjs-dist` for PDF text. Node 22.13+ (it uses the
built-in `node:sqlite`).

## Why it exists

Both come out of a client-facing AI receptionist I built. Its knowledge base outgrew the
"paste everything into the prompt" approach, which is when RAG starts to pay. Its onboarding then needed
a restaurant's menu without someone typing 60 dishes by hand. The unglamorous parts turned out to matter
most: not re-embedding what hasn't changed, knowing what each call cost, and never letting a model
invent a price. This repo is those pieces with the product stripped out.

## Setup

```bash
git clone <this repo> && cd gemini-toolkit
npm install
cp .env.example .env        # add GEMINI_API_KEY (https://aistudio.google.com/apikey)
npm link                    # optional: puts `gemini-toolkit` and `menu-extract` on your PATH
```

Without `npm link`, run `node bin/gemini-toolkit.mjs ...` and `node bin/menu-extract.mjs ...`.

## Part 1: RAG over SQLite

```bash
gemini-toolkit index demo/docs
# 5 files: 5 new, 0 changed, 0 unchanged, 0 removed. 5 chunks embedded, 5 stored.

gemini-toolkit ask "Can I return a tent I washed?"
gemini-toolkit ask "when can I get a refund" --chunks      # just show what was retrieved
gemini-toolkit index demo/docs                              # again: all unchanged, 0 chunks embedded
```

`demo/docs` is five short markdown files for an invented outdoor shop. Point `index` at any folder of
`.md`, `.txt` or `.pdf` files instead. `--collection NAME` keeps separate knowledge bases in one DB.

How it works:

- **Chunking** splits on blank lines, packs paragraphs up to ~900 characters, and hard-wraps anything
  longer with overlap. The file's title is prepended to each chunk before embedding, so a chunk keeps
  its context.
- **Hash-gated re-indexing.** Each source file is stored with a hash of its content plus the embedding
  model, dimension and chunk settings. Run `index` again and unchanged files cost nothing; an edited
  file is re-embedded; a deleted file's chunks are dropped. Changing `GT_EMBED_DIM` re-embeds everything,
  because the old vectors no longer fit.
- **Embeddings** are `gemini-embedding-001` truncated to 768 dimensions (Matryoshka), stored normalised
  as Float32 BLOBs. Documents are embedded as `RETRIEVAL_DOCUMENT`, queries as `RETRIEVAL_QUERY`.
- **Retrieval** loads the collection's vectors and ranks by cosine. That is sub-millisecond at the tens
  to low thousands of chunks a folder of notes makes. Past roughly 100k chunks you want a real index.
- **Answers** hand the top-K passages to `gemini-2.5-flash` with an instruction to answer only from
  them, cite `[1]`-style, and say "I don't know" otherwise.

### The cost ledger

Every Gemini call (embedding, answer, menu extraction) lands as one row in `llm_usage`: tokens in, out
and cached, the dollars at the rate in force, a `tag` (the collection, or `menu`) and a `purpose`.

```bash
gemini-toolkit usage            # all windows: by tag, by model, by purpose
gemini-toolkit usage daily      # daily | weekly | monthly | all
gemini-toolkit usage --json
```

```
== DAILY == 7 calls, $0.0031
  by model
    gemini-2.5-flash            $0.0027      3 calls  in 4.1k / out 810
    gemini-embedding-001        $0.0004      4 calls  in 2.6k / out 0
```

(Illustrative layout; your numbers will differ.)

- Rates live in `src/rates.json` ($ per 1M tokens). **Prices drift**; the defaults were checked on
  2026-06-26. Point `GT_RATES` at your own JSON file to override or add models.
- A model with no rate is logged at $0 and called out in the report, never guessed. A sibling model
  (`gemini-2.5-flash-lite`) does not inherit `gemini-2.5-flash` prices.
- Cached prompt tokens are priced separately and "thinking" tokens are billed as output, as Gemini does.
- Optional guard: `GT_DAILY_BUDGET_USD=1.00` makes the next call fail once today's total reaches it.

## Part 2: menu-extract

```bash
menu-extract demo/sample-menu.pdf > items.json
menu-extract photo1.jpg photo2.jpg --out items.json
menu-extract menu.pdf --text            # text-layer mode: PDFs with real text, no vision
```

stderr says how many rows need review; stdout (or `--out`) is the JSON. A real run looks like
[`demo/sample-menu.expected.json`](demo/sample-menu.expected.json). **That file is hand-written to show
the shape, not captured from a live run.**

```json
{ "name": "Prime ribs of beef, au jus", "price": "$0.75-$1.10", "category": "ROASTS", "confidence": 0.9, "needsReview": false },
{ "name": "Vanilla ice cream", "price": "", "category": "PASTRY AND DESSERT", "confidence": 0.3, "needsReview": true }
```

Design choices:

- **Vision, not OCR.** On a menu, a dish and its price are paired by layout: same row, next column, a
  dotted leader line. Flattened OCR text mis-pairs them. Reading the page as an image keeps the pairing.
- **Prices are verbatim.** Ranges (`$0.75-$1.10`), per-unit marks (`/dish`) and "market price" are kept
  exactly as printed. Nothing is normalised, rounded or converted.
- **Blank beats wrong.** If the model can't be sure which price belongs to a dish, it leaves the price
  empty with low confidence. Rows with no price, or confidence at or below 0.6, get `needsReview: true`.
- **Draft only.** The tool writes the JSON you ask for and nothing else. A person confirms the rows.
- **Big files aren't dropped.** Files that fit a 12 MB inline budget go in the request; a bigger file is
  uploaded through the Files API; past 45 MB it is skipped with a message. At most 3 files per run.
  A failed upload skips that file and says so, and Gemini is never called with no menu attached.
- **Repeats collapse.** The same dish read twice becomes one row, keeping the copy that carries the price.
- **Text mode and `index` for PDFs** use `pdfjs-dist`. A scan with no text layer gives an explicit
  "no text layer, use vision mode or paste the text" instead of silently indexing nothing.

`demo/sample-menu.pdf` is a made-up hotel bill of fare in the style of an 1890s menu, written for this
repo (`scripts/make-sample-menu.mjs` generates it). It includes a price range, per-unit prices, a
market-price line and a dish with no price.

## Tests

```bash
npm test
```

37 tests, no API key and no network: the Gemini client is replaced by a fake, and embeddings by a
keyword vector. They cover chunking, the hash gate (second run embeds 0, an edit re-embeds one file,
deletions drop), retrieval ranking, cost math and windows, the budget guard, embedding batching, retry,
menu parsing and dedup, the inline/upload split, the CLI end to end, and PDF text extraction (skipped
if `pdfjs-dist` isn't installed). CI runs the same thing with no secrets.

## Layout

```
bin/            the two executables
src/gemini.mjs  the only file that talks to Gemini; every call is ledgered
src/rag.mjs     chunking, hash-gated indexing, retrieval, answers
src/ledger.mjs  rates, cost math, report, budget guard
src/menu.mjs    menu extraction
src/db.mjs      one SQLite file: chunks, vectors, ledger
demo/           sample notes + sample menu
```

## Not included

No vector extension, no web server, no Google Sheets mirror of the report, no Claude/Anthropic rates
(add them in a `GT_RATES` file if you log those calls through `record()`).

## License

MIT, see [LICENSE](LICENSE).
