// notify-designer
// One call at the end of every call: it sends the handoff note to the designer
// on Telegram AND writes the row to the lead log.
//
// These were two tools to begin with. The voice platform reliably executes one
// custom tool per turn, so the second one - the log write - kept being dropped,
// which is the one that must never be dropped: it is what stops the same caller
// being opened as a new lead tomorrow. Merging them removes that failure mode.
//
// book-consultation writes a row too, as a safety net for the booked path. Both
// derive the same call_ref from the caller's number and the date, and both
// upsert on call_ref, so whichever fires first wins. This one fills in the
// fields the booking could not know - verdict, timeline, decision maker, what is
// still unknown - so when it arrives second it updates rather than ignores.
//
// The bot token lives in agent_secrets and is read with the service role inside
// Supabase, so the voice platform only ever knows the shared secret.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FALLBACK_SECRET = "REDACTED_SET_AGENT_SHARED_SECRET_IN_SUPABASE";
const SECRET = Deno.env.get("AGENT_SHARED_SECRET") ?? FALLBACK_SECRET;
const TZ = "Asia/Kolkata";

const VERDICTS = ["qualified", "declined", "escalated", "not_an_enquiry", "dropped"];
const REASONS = [
  "out_of_area", "advice_only", "out_of_scope",
  "timeline_too_short", "budget_below_floor", "other",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-agent-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

async function secret(key: string, fallback = ""): Promise<string> {
  const fromEnv = Deno.env.get(key);
  if (fromEnv) return fromEnv;
  const { data } = await db.from("agent_secrets").select("value").eq("key", key).maybeSingle();
  return data?.value ?? fallback;
}

const str = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  const low = s.toLowerCase();
  return s === "" || low === "not established" || low === "null" || low === "none" ? null : s;
};
const bool = (v: unknown) => v === true || v === "true" || v === "yes";
const int = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const uuid = (v: unknown) => {
  const s = str(v);
  return s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
};
const ts = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

function e164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return raw.trim();
}

// Same formula as book-consultation. One caller, one day, one row.
function autoRef(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10) || "unknown";
  const day = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  return `auto-${digits}-${day}`;
}

function line(label: string, value: unknown): string | null {
  const s = str(value);
  return s ? `${label}: ${s}` : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({}, 200);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (req.headers.get("x-agent-secret") !== SECRET) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const rawPhone = str(body.caller_number);
  if (!rawPhone) {
    return json({ sent: false, logged: false, error: "no caller number",
      instruction: "Confirm the caller's number, then call this again." }, 200);
  }
  const caller = e164(rawPhone);

  const verdictRaw = String(body.verdict ?? "").toLowerCase().trim();
  const verdict = VERDICTS.includes(verdictRaw) ? verdictRaw : null;

  const kind = String(
    body.kind ??
    (verdict === "escalated" ? "escalate" : verdict === "declined" ? "decline" : "new_lead"),
  ).toLowerCase();
  const header =
    kind === "escalate" ? "ESCALATE \u2014 call Nikhil now"
    : kind === "decline" ? "DECLINED \u2014 for the weekly review"
    : "NEW LEAD \u2014 Aangan Front Desk";

  // ---- 1. the designer's alert -------------------------------------------
  const rows = [
    line("Name", body.name),
    line("Number", caller),
    line("Area", body.area),
    line("Project", body.project_type),
    line("Size", int(body.size_sqft) ? `${int(body.size_sqft)} sqft` : null),
    line("Current state", body.current_state),
    line("Timeline", body.timeline),
    line("Decision maker", body.decision_maker),
    line("Budget", body.budget_note),
    line("Found us", body.source),
    line("Verdict", verdict ? verdict.toUpperCase() : null),
    line("Reason", body.decline_reason),
    line("Still unknown", body.still_unknown),
    line("Booked", body.consultation_at),
    line("Note", body.handoff_note),
  ].filter(Boolean);

  const text = `${header}\n\n${rows.join("\n")}`;

  const BOT_TOKEN = await secret("TELEGRAM_BOT_TOKEN");
  const CHAT_ID = await secret("TELEGRAM_CHAT_ID", "");

  let sent = false;
  let sendError: string | null = null;
  if (!BOT_TOKEN) {
    sendError = "TELEGRAM_BOT_TOKEN not configured";
  } else {
    try {
      const tg = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text }),
      }).then((r) => r.json());
      sent = tg.ok === true;
      if (!sent) sendError = tg.description ?? "telegram rejected the message";
    } catch (e) {
      sendError = String(e);
    }
  }

  // ---- 2. the lead log ----------------------------------------------------
  const call_ref = str(body.call_ref) ?? autoRef(caller);

  // Only write the fields we actually have, so arriving second never blanks
  // what the booking already recorded.
  const row: Record<string, unknown> = {
    call_ref,
    ended_at: new Date().toISOString(),
    caller_number: caller,
    verdict,
    handoff_note: str(body.handoff_note) ?? text,
  };

  // Booleans are only ever written when TRUE. Writing false would let this call,
  // arriving after the booking has already set booked = true, quietly unbook the
  // lead - a silent loss nobody would notice until the weekly review.
  if (verdict === "escalated" || bool(body.escalated)) row.escalated = true;
  if (bool(body.repeat_caller)) row.repeat_caller = true;
  if (bool(body.budget_mentioned) || str(body.budget_note)) row.budget_mentioned = true;
  if (bool(body.booked) || ts(body.consultation_at)) row.booked = true;
  if (bool(body.site_visit)) row.site_visit = true;

  const optional: Record<string, unknown> = {
    started_at: ts(body.started_at),
    call_seconds: int(body.call_seconds),
    prior_call_id: uuid(body.prior_call_id),
    name: str(body.name),
    area: str(body.area),
    project_type: str(body.project_type),
    size_sqft: int(body.size_sqft),
    current_state: str(body.current_state),
    timeline: str(body.timeline),
    decision_maker: str(body.decision_maker),
    budget_note: str(body.budget_note),
    source: str(body.source),
    consultation_at: ts(body.consultation_at),
    still_unknown: str(body.still_unknown),
    decline_reason:
      verdict === "declined" &&
      REASONS.includes(String(body.decline_reason ?? "").toLowerCase().trim())
        ? String(body.decline_reason).toLowerCase().trim()
        : null,
    criteria_failed: Array.isArray(body.criteria_failed)
      ? (body.criteria_failed as unknown[]).map(String)
      : null,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== null) row[k] = v;
  if (!row.started_at) row.started_at = new Date().toISOString();

  let logged = false;
  let logError: string | null = null;
  if (!verdict) {
    logError = `verdict must be one of ${VERDICTS.join(", ")}`;
  } else {
    const { error } = await db.from("calls").upsert(row, { onConflict: "call_ref" });
    if (error) logError = error.message;
    else logged = true;
  }

  return json({
    sent,
    logged,
    call_ref,
    ...(sendError ? { send_error: sendError } : {}),
    ...(logError ? { log_error: logError } : {}),
    instruction: logged
      ? "Done. Say goodbye."
      : "The call was not logged. Call this again with a valid verdict and the caller's number.",
  });
});
