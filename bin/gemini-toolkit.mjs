#!/usr/bin/env node
// node:sqlite prints an "experimental" warning on Node 22; hide just that one line.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w?.message ?? w).includes("SQLite") ? undefined : emit.call(process, w, ...a));
const { run } = await import("../src/cli.mjs");
try { process.loadEnvFile(); } catch { /* no .env: rely on the real environment */ }
process.exitCode = await run(process.argv.slice(2));
