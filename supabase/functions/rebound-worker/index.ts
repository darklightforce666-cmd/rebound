// REBOUND hosted worker — Supabase Edge Function stub. The worker code is the repository's own bundle
// (scripts/rewards/build-hosted-worker.cjs), pinned to an exact commit so it cannot change underneath.
// Auth: the pg_cron job sends a random token kept in Supabase Vault (x-rebound-cron).
import { handle } from "https://cdn.jsdelivr.net/gh/darklightforce666-cmd/rebound@c900fc87eaa938b7db8ed3889a6fa33735d47270/supabase/functions/rebound-worker/worker-bundle.mjs";

const clip = (e: unknown) => String((e as Error)?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://[redacted]").slice(0, 300);
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  let r: { status: number; body: unknown; work?: Promise<unknown> };
  let role = "all";
  try { const b = await req.json(); if (typeof b?.role === "string") role = b.role; } catch { /* empty body */ }
  try { r = await handle({ dbUrl: Deno.env.get("SUPABASE_DB_URL"), token: req.headers.get("x-rebound-cron"), role }); }
  catch (e) { r = { status: 500, body: { error: clip(e) } }; }
  if (r.work) {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil(r.work.then((x) => console.log("pass", JSON.stringify(x)), (e) => console.error("pass failed", clip(e))));
  }
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
});
