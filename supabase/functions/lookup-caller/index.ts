// Step 0 of the agent prompt: has this number called in the last 24 hours?
//
// Auth is a shared secret in the x-agent-secret header, not a JWT, because the
// caller is Vaani's tool runner rather than a signed-in user. verify_jwt is off
// for that reason and the check below is what replaces it.
//
// SECRET HANDLING: set AGENT_SHARED_SECRET in Supabase > Functions > Secrets.
// The deployed function carries a fallback constant so the pipeline works before
// that is configured; it is REDACTED here because this repository is public.
//
// Uses the service role internally, so no privileged key ever leaves Supabase.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FALLBACK = "REDACTED_SET_AGENT_SHARED_SECRET_IN_SUPABASE";
const SECRET = Deno.env.get("AGENT_SHARED_SECRET") ?? FALLBACK;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-agent-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({}, 200);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (req.headers.get("x-agent-secret") !== SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // The voice platform may send this as number, caller_number, from or phone
  // depending on how the tool was wired. Accept all of them rather than failing
  // the first thing that happens on every call. This was a real bug: the tool
  // declared "number", the function read "caller_number", and Step 0 returned
  // 400 on every single call until it was tested end to end.
  const number = String(
    body.number ?? body.caller_number ?? body.from ?? body.phone ?? "",
  ).trim();

  // No number is not an error. On a web test, or a withheld caller ID, there is
  // simply nothing to look up - say so and let the call proceed.
  if (!number) {
    return json({
      found: false,
      instruction: "No caller number available. Treat this as a new caller and qualify from the start.",
    });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Match on the last ten digits so +91 98..., 098... and 98... are one caller.
  const digits = number.replace(/\D/g, "");
  const tail = digits.slice(-10);

  const tryLookup = async (n: string) => {
    const { data, error } = await db.rpc("recent_call_for", { p_number: n });
    if (error) return null;
    return Array.isArray(data) ? data[0] : data;
  };

  let prior = await tryLookup(number);
  if (!prior && tail && tail !== number) prior = await tryLookup(`+91${tail}`);
  if (!prior && tail) prior = await tryLookup(tail);

  if (!prior) {
    return json({
      found: false,
      instruction: "New caller. Greet normally and qualify from the start.",
    });
  }

  // T17: a caller whose line dropped and who rang back is ONE lead, not two.
  const dropped = prior.verdict === "dropped";

  return json({
    found: true,
    prior_call_id: prior.id,
    started_at: prior.started_at,
    name: prior.name,
    area: prior.area,
    project_type: prior.project_type,
    verdict: prior.verdict,
    still_unknown: prior.still_unknown,
    instruction: dropped
      ? "This number called within the last 24 hours and that call was cut off. Apologise for the line, say 'Yes, of course - I have you here', and pick up where it ended. Do NOT start over and do NOT open a new lead."
      : "This number called within the last 24 hours. Open with 'Yes, of course - I have you here', continue the same lead, and do not re-ask what you already know.",
  });
});
