// Shared fakes: no network, no key.
export const VOCAB = ["refund", "return", "shipping", "delivery", "tent", "warranty", "hours", "open", "sleeping", "wash"];

/** Keyword-presence vectors, normalised like the real embed(). */
export const fakeEmbed = async (texts) =>
  texts.map((t) => {
    const s = String(t).toLowerCase();
    const v = Float32Array.from(VOCAB.map((w) => (s.includes(w) ? 1 : 0)));
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / n);
  });

/** Counts how many texts were embedded, so tests can prove the hash gate skipped work. */
export function countingEmbed() {
  const f = async (texts, o) => { f.texts += texts.length; f.calls++; return fakeEmbed(texts, o); };
  f.texts = 0; f.calls = 0;
  return f;
}

/** A stand-in for @google/genai's GoogleGenAI client. */
export function fakeClient({ text = "{}", usage = { promptTokenCount: 1000, candidatesTokenCount: 200 }, embedTokens } = {}) {
  const c = {
    calls: { embed: [], generate: [], upload: [] },
    models: {
      async embedContent(req) {
        c.calls.embed.push(req);
        return { embeddings: req.contents.map((t) => ({ values: [t.length, 1, 0], tokenCount: embedTokens })) };
      },
      async generateContent(req) {
        c.calls.generate.push(req);
        return { text: typeof text === "function" ? text(req) : text, usageMetadata: usage };
      },
    },
    files: {
      async upload(req) { c.calls.upload.push(req); return { name: "files/1", uri: "files/uploaded-1", state: "ACTIVE", mimeType: req.config.mimeType }; },
      async get() { throw new Error("not needed"); },
    },
  };
  return c;
}
