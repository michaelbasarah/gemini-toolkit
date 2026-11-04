// Per-call cost ledger. Every model call becomes one row: tokens in/out/cached, the $ at the rate that
// was current when the call ran, and a free-form `tag` + `purpose` so a report can slice spend.
import { readFileSync } from "node:fs";

const DEFAULT_RATES = JSON.parse(readFileSync(new URL("./rates.json", import.meta.url), "utf8"));

/** Defaults from src/rates.json, with GT_RATES (a JSON file of the same shape) merged on top. */
export function loadRates(file = process.env.GT_RATES) {
  const rates = { ...DEFAULT_RATES };
  if (file) Object.assign(rates, JSON.parse(readFileSync(file, "utf8")));
  delete rates._note;
  return rates;
}

/**
 * Find a model's rate. Exact match first; otherwise accept a dated/preview suffix of a known model
 * ("gemini-2.5-flash-preview-09-2025") but NOT a different model that merely shares a prefix
 * ("gemini-2.5-flash-lite" must not silently bill at flash prices).
 */
export function rateFor(model, rates = loadRates()) {
  if (rates[model]) return rates[model];
  const key = Object.keys(rates)
    .sort((a, b) => b.length - a.length)
    .find((k) => String(model).startsWith(k) && /^-(\d|preview|latest|exp)/.test(String(model).slice(k.length)));
  return key ? rates[key] : null;
}

/** $ for a token count. Returns null when the model has no rate (caller records $0 + priced=0). */
export function cost(model, { inTokens = 0, outTokens = 0, cacheTokens = 0 } = {}, rates = loadRates()) {
  const r = rateFor(model, rates);
  if (!r) return null;
  return (inTokens * (r.in || 0) + outTokens * (r.out || 0) + cacheTokens * (r.cache || 0)) / 1e6;
}

/** Insert one ledger row. Returns the $ recorded. */
export function record(db, { tag = "default", provider = "gemini", model, purpose = "other", inTokens = 0, outTokens = 0, cacheTokens = 0, rates }) {
  const usd = cost(model, { inTokens, outTokens, cacheTokens }, rates);
  db.prepare(
    `INSERT INTO llm_usage (created_at, tag, provider, model, purpose, in_tokens, out_tokens, cache_tokens, cost_usd, priced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(new Date().toISOString(), tag, provider, model, purpose, inTokens, outTokens, cacheTokens, usd ?? 0, usd == null ? 0 : 1);
  return usd ?? 0;
}

/**
 * Record one generateContent call from the SDK's `usageMetadata`. promptTokenCount INCLUDES cached
 * tokens, so they are split out; "thinking" tokens are billed as output.
 */
export function recordGemini(db, { tag, purpose, model, usageMetadata, rates }) {
  const u = usageMetadata || {};
  const cacheTokens = u.cachedContentTokenCount || 0;
  return record(db, {
    tag, purpose, model, rates,
    inTokens: Math.max(0, (u.promptTokenCount || 0) - cacheTokens),
    outTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    cacheTokens,
  });
}

/** Record an embedding call: input tokens only. */
export function recordEmbedding(db, { tag, purpose, model, tokens, rates }) {
  return record(db, { tag, purpose, model, rates, inTokens: Math.max(0, Math.round(tokens || 0)) });
}

// --- Reporting ---------------------------------------------------------------------------------

/** ISO timestamp for 00:00 UTC, N calendar days ago counting today as day 1. */
export function sinceDaysAgo(n, now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n + 1);
  return d.toISOString();
}

export const WINDOWS = {
  daily: (now) => sinceDaysAgo(1, now),
  weekly: (now) => sinceDaysAgo(7, now),
  monthly: (now) => sinceDaysAgo(30, now),
  all: () => null,
};

const DIMS = { tag: "tag", model: "model", purpose: "purpose" };

/** Spend grouped by one dimension (tag | model | purpose) since an ISO bound (null = forever). */
export function usageBy(db, dim, { since = null } = {}) {
  if (!DIMS[dim]) throw new Error(`unknown dimension "${dim}"`);
  return db.prepare(
    `SELECT ${DIMS[dim]} AS key, COUNT(*) AS calls, SUM(in_tokens) AS in_tokens, SUM(out_tokens) AS out_tokens,
            SUM(cache_tokens) AS cache_tokens, SUM(cost_usd) AS cost_usd, SUM(1 - priced) AS unpriced_calls
     FROM llm_usage WHERE (? IS NULL OR created_at >= ?)
     GROUP BY ${DIMS[dim]} ORDER BY cost_usd DESC, calls DESC`,
  ).all(since, since);
}

/** The whole report for one window: totals plus the three breakdowns. */
export function usageReport(db, window = "all", now = new Date()) {
  if (!WINDOWS[window]) throw new Error(`unknown window "${window}", use daily | weekly | monthly | all`);
  const since = WINDOWS[window](now);
  const by = { tag: usageBy(db, "tag", { since }), model: usageBy(db, "model", { since }), purpose: usageBy(db, "purpose", { since }) };
  const sum = (k) => by.model.reduce((n, r) => n + (r[k] || 0), 0);
  return { window, since, calls: sum("calls"), cost_usd: sum("cost_usd"), unpriced_calls: sum("unpriced_calls"), by };
}

/** Plain-text rendering of usageReport(). */
export function formatReport(rep) {
  const usd = (n) => `$${n.toFixed(4)}`;
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
  const out = [`== ${rep.window.toUpperCase()} == ${rep.calls} calls, ${usd(rep.cost_usd)}`];
  for (const [label, rows] of Object.entries(rep.by)) {
    out.push(`  by ${label}`);
    if (!rows.length) { out.push("    (no calls)"); continue; }
    for (const r of rows) {
      out.push(`    ${String(r.key).padEnd(24)} ${usd(r.cost_usd).padStart(10)}  ${String(r.calls).padStart(5)} calls  in ${tok(r.in_tokens)} / out ${tok(r.out_tokens)}`);
    }
  }
  if (rep.unpriced_calls) out.push(`  ! ${rep.unpriced_calls} call(s) used a model with no rate (logged at $0). Add it to a GT_RATES file.`);
  return out.join("\n");
}

// --- Budget guard ------------------------------------------------------------------------------

export class BudgetExceeded extends Error {
  constructor(spent, cap) {
    super(`daily budget reached: $${spent.toFixed(4)} spent of $${cap.toFixed(2)} (GT_DAILY_BUDGET_USD)`);
    this.name = "BudgetExceeded";
  }
}

/** $ recorded since 00:00 UTC today. */
export function spendToday(db, now = new Date()) {
  return db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_usage WHERE created_at >= ?").get(sinceDaysAgo(1, now)).s;
}

/** Throw BudgetExceeded when a cap is set and today's spend has reached it. No cap = no check. */
export function assertWithinBudget(db, cap = Number(process.env.GT_DAILY_BUDGET_USD) || 0) {
  if (!(cap > 0)) return;
  const spent = spendToday(db);
  if (spent >= cap) throw new BudgetExceeded(spent, cap);
}
