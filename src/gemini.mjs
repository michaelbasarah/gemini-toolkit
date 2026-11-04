// The only file that talks to Gemini. Every call goes through here so every call lands in the ledger.
// `client` is injectable (anything shaped like @google/genai's GoogleGenAI), which is how the tests run
// with no API key.
import { recordEmbedding, recordGemini, assertWithinBudget } from "./ledger.mjs";

export const EMBED_BATCH = 100; // embedContent accepts up to 100 texts per request

/** Retry transient failures (429 / 5xx) with a short linear backoff; anything else throws at once. */
export async function withRetry(fn, { tries = 3, baseMs = 700, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const s = err?.status;
      const transient = s === 429 || (s >= 500 && s <= 504);
      if (!transient || i >= tries - 1) throw err;
      await sleep(baseMs * (i + 1));
    }
  }
}

/** L2-normalise so a plain dot product is cosine similarity. */
export function normalize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

/**
 * Build the Gemini helpers bound to a ledger database.
 *   embed(texts, {taskType, purpose})            -> Float32Array[] (normalised)
 *   generateText({system, contents, purpose})    -> string
 *   generateJson({system, contents, schema, purpose}) -> parsed object
 *   uploadFile({buffer, mimeType, displayName})  -> {fileUri, mimeType}   (Files API, for big PDFs)
 */
export async function createGemini({ db, client, apiKey = process.env.GEMINI_API_KEY, tag = "default", rates, retry = {} } = {}) {
  if (!client) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set (copy .env.example to .env)");
    const { GoogleGenAI } = await import("@google/genai");
    client = new GoogleGenAI({ apiKey });
  }
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const embedModel = process.env.GT_EMBED_MODEL || "gemini-embedding-001";
  const dim = Number(process.env.GT_EMBED_DIM) || 768;
  const guard = () => assertWithinBudget(db);

  async function embed(texts, { taskType = "RETRIEVAL_DOCUMENT", purpose } = {}) {
    const out = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      guard();
      const resp = await withRetry(
        () => client.models.embedContent({ model: embedModel, contents: batch, config: { outputDimensionality: dim, taskType } }),
        retry,
      );
      // Prefer reported per-embedding token counts; else estimate ~4 chars/token so the call is still billed.
      const reported = (resp.embeddings || []).reduce((n, e) => n + (e?.tokenCount || 0), 0);
      const tokens = reported || Math.ceil(batch.reduce((n, t) => n + String(t).length, 0) / 4);
      recordEmbedding(db, { tag, model: embedModel, tokens, rates, purpose: purpose || (taskType === "RETRIEVAL_QUERY" ? "rag-query" : "rag-index") });
      for (const e of resp.embeddings) out.push(normalize(Float32Array.from(e.values)));
    }
    return out;
  }

  async function generate({ system, contents, config = {}, purpose }) {
    guard();
    const resp = await withRetry(
      () => client.models.generateContent({ model, contents, config: { systemInstruction: system, ...config } }),
      retry,
    );
    recordGemini(db, { tag, purpose, model, usageMetadata: resp.usageMetadata, rates });
    return resp.text;
  }

  const generateText = ({ system, contents, purpose = "answer", temperature = 0.2 }) =>
    generate({ system, contents, purpose, config: { temperature } });

  const generateJson = async ({ system, contents, schema, purpose = "json", temperature = 0.2 }) =>
    JSON.parse(await generate({ system, contents, purpose, config: { temperature, responseMimeType: "application/json", responseSchema: schema } }));

  /**
   * Upload bytes to the Files API and wait until ACTIVE. Needed for files too big to ride inline
   * (base64 inflates ~1.33x against a ~20 MB request ceiling).
   */
  async function uploadFile({ buffer, mimeType, displayName, pollMs = 1500, timeoutMs = 90000 }) {
    if (!buffer?.length) throw new Error("uploadFile: empty buffer");
    if (!mimeType) throw new Error("uploadFile: missing mimeType");
    const blob = new Blob([buffer], { type: mimeType });
    let file = await withRetry(() => client.files.upload({ file: blob, config: { mimeType, displayName } }), retry);
    const deadline = Date.now() + timeoutMs;
    while (file?.state && file.state !== "ACTIVE") {
      if (file.state === "FAILED") throw new Error(`Gemini file processing FAILED (${file?.error?.message || file?.name || "unknown"})`);
      if (Date.now() >= deadline) throw new Error(`Gemini file not ACTIVE after ${timeoutMs}ms (state=${file.state})`);
      await new Promise((r) => setTimeout(r, pollMs));
      file = await withRetry(() => client.files.get({ name: file.name }), retry);
    }
    if (!file?.uri) throw new Error("Gemini file upload returned no uri");
    return { fileUri: file.uri, mimeType: file.mimeType || mimeType };
  }

  return { model, embedModel, dim, embed, generateText, generateJson, uploadFile };
}
