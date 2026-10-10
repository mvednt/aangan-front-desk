// book-consultation
// Two modes, because booking on a phone call is two turns:
//   action="slots"  -> the next few openings, already phrased for speech
//   action="book"   -> hold one of them
// The action may arrive in the body or in the query string, because the voice
// platform exposes these as two separate tools pinned to ?action=.
//
// A successful booking ALSO writes the lead log and sends the designer's note.
// That is deliberate belt and braces: the platform runs one custom tool per
// turn, so on a booked call the closing notify_designer can lose its turn. The
// booking is the one call that always happens on a qualified lead, so the row
// is written here too. Both paths derive the same call_ref from the caller's
// number and the date, and both upsert, so whichever fires first wins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FALLBACK_SECRET = "REDACTED_SET_AGENT_SHARED_SECRET_IN_SUPABASE";
const SECRET = Deno.env.get("AGENT_SHARED_SECRET") ?? FALLBACK_SECRET;
const TZ = "Asia/Kolkata";

// Cal.com rejects addresses it cannot deliver to, so there is no inventing one.
// When the caller will not give an email, the booking goes to the studio's own
// inbox and the caller is confirmed by phone instead.
const STUDIO_INBOX = Deno.env.get("STUDIO_INBOX") ?? "";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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
const int = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

// Callers say "nine eight two two..."; Cal.com wants E.164. Pune is +91.
// Without this, every single booking failed with "invalid_number".
function e164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

// Same formula in notify-designer. One caller, one day, one row.
function autoRef(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10) || "unknown";
  const day = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  return `auto-${digits}-${day}`;
}

function speak(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-IN", { weekday: "long", timeZone: TZ });
  const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: TZ });
  const time = d.toLocaleTimeString("en-IN", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ,
  });
  return `${day} ${date}, ${time}`;
}

const looksLikeEmail = (s: string) => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(s);

async function openings(KEY: string, EVENT_TYPE_ID: number): Promise<string[]> {
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const url = new URL("https://api.cal.com/v2/slots");
  url.searchParams.set("eventTypeId", String(EVENT_TYPE_ID));
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());
  url.searchParams.set("timeZone", TZ);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, "cal-api-version": "2024-09-04" },
  }).then((r) => r.json());

  if (res.status !== "success") return [];
  const flat: string[] = [];
  for (const day of Object.keys(res.data ?? {}).sort()) {
    for (const s of res.data[day]) flat.push(s.start ?? s);
  }
  return flat;
}

// Match whatever the agent said against the real openings. A voice agent will
// not hand back an ISO string cleanly every time, so accept a full ISO string,
// a date, a weekday name, a day number, or a time - and combinations.
function resolve(wanted: string, slots: string[]): string | null {
  const raw = wanted.trim();
  if (!raw) return null;

  const exact = slots.find((s) => s === raw);
  if (exact) return exact;

  const asDate = new Date(raw);
  if (!isNaN(asDate.getTime())) {
    let best: string | null = null;
    let bestGap = Infinity;
    for (const s of slots) {
      const gap = Math.abs(new Date(s).getTime() - asDate.getTime());
      if (gap < bestGap) { bestGap = gap; best = s; }
    }
    if (best && bestGap <= 5 * 60 * 1000) return best;
  }

  const low = raw.toLowerCase();
  const dayNum = low.match(/\b(\d{1,2})(st|nd|rd|th)?\b/)?.[1];
  const weekday = low.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/)?.[1];
  const hour = low.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (!dayNum && !weekday && !hour) return null;

  const candidates = slots.filter((s) => {
    const d = new Date(s);
    const wd = d.toLocaleDateString("en-IN", { weekday: "long", timeZone: TZ }).toLowerCase();
    const dn = d.toLocaleDateString("en-IN", { day: "numeric", timeZone: TZ });
    if (weekday && wd !== weekday) return false;
    if (dayNum && dn !== dayNum) return false;
    if (hour) {
      const t = d.toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ,
      }).toLowerCase().replace(/\s+/g, " ");
      const want = `${hour[1]}:${hour[2] ?? "00"} ${hour[3]}`;
      if (t !== want) return false;
    }
    return true;
  });

  return candidates[0] ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({}, 200);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (req.headers.get("x-agent-secret") !== SECRET) return json({ error: "unauthorized" }, 401);

  const KEY = await secret("CALCOM_API_KEY");
  const EVENT_TYPE_ID = Number(await secret("CALCOM_EVENT_TYPE_ID", "0"));
  if (!KEY || !EVENT_TYPE_ID) return json({ error: "cal.com not configured" }, 500);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* an empty body is fine when the action is pinned in the URL */ }

  const fromUrl = new URL(req.url).searchParams.get("action");
  const action = String(fromUrl ?? body.action ?? "slots").toLowerCase();

  if (action === "slots") {
    const flat = await openings(KEY, EVENT_TYPE_ID);
    // Spread the offer across days rather than four slots in one morning.
    const byDay = new Map<string, string>();
    for (const iso of flat) {
      const k = iso.slice(0, 10);
      if (!byDay.has(k)) byDay.set(k, iso);
    }
    const offer = [...byDay.values()].slice(0, 4);

    return json({
      found: offer.length > 0,
      slots: offer.map((iso) => ({ start: iso, say: speak(iso) })),
      instruction: offer.length
        ? `Offer two of these, not all four, in the words given in "say". When the caller picks one, call aangan_hold_slot with what they chose, their name and their phone number. Ask for an email for the confirmation; if they will not give one, book anyway and say the designer will confirm by phone.`
        : `Nothing is open in the next two weeks. Tell the caller the designer will ring them back to find a time, and send the handoff note.`,
    });
  }

  if (action === "book") {
    const asked = String(body.start ?? body.slot ?? "").trim();
    const name = String(body.name ?? "").trim();
    const phone = e164(String(body.caller_number ?? body.phone ?? ""));

    if (!name) {
      return json({ booked: false, error: "no name",
        instruction: "Ask the caller for their name, then call this again." }, 200);
    }
    if (!phone) {
      return json({ booked: false, error: "no usable phone number",
        instruction: "Ask the caller to confirm their ten digit number, then call this again." }, 200);
    }

    const flat = await openings(KEY, EVENT_TYPE_ID);
    const start = resolve(asked, flat);
    if (!start) {
      return json({
        booked: false,
        error: "that time is not open",
        slots: flat.slice(0, 4).map((iso) => ({ start: iso, say: speak(iso) })),
        instruction: "Do not promise the slot. Offer one of these instead.",
      }, 200);
    }

    const given = String(body.email ?? "").trim();
    const email = looksLikeEmail(given) ? given : STUDIO_INBOX;
    const confirmedByPhone = email === STUDIO_INBOX;

    const res = await fetch("https://api.cal.com/v2/bookings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        "cal-api-version": "2024-08-13",
      },
      body: JSON.stringify({
        start,
        eventTypeId: EVENT_TYPE_ID,
        attendee: { name, email, timeZone: TZ, language: "en", phoneNumber: phone },
        bookingFieldsResponses: {
          area: String(body.area ?? "not established"),
          project_type: String(body.project_type ?? "not established"),
          handoff: String(body.handoff_note ?? ""),
        },
        metadata: { source: "aangan-front-desk" },
      }),
    }).then((r) => r.json());

    if (res.status !== "success") {
      return json({
        booked: false,
        error: res.error?.message ?? "that slot was taken",
        instruction: "Do not promise the slot. Offer the next one, or say the designer will call back.",
      }, 200);
    }

    const d = res.data;

    // ---- the safety net: log the lead and alert the designer ---------------
    const call_ref = str(body.call_ref) ?? autoRef(phone);
    let logged = false;

    try {
      const { error } = await db.from("calls").upsert({
        call_ref,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        caller_number: phone,
        name,
        area: str(body.area),
        project_type: str(body.project_type),
        size_sqft: int(body.size_sqft),
        verdict: "qualified",
        booked: true,
        consultation_at: d.start,
        handoff_note: str(body.handoff_note),
      }, { onConflict: "call_ref", ignoreDuplicates: true });
      logged = !error;
    } catch { /* never fail a confirmed booking over the log */ }

    try {
      const BOT_TOKEN = await secret("TELEGRAM_BOT_TOKEN");
      const CHAT_ID = await secret("TELEGRAM_CHAT_ID", "");
      if (BOT_TOKEN) {
        const lines = [
          `Name: ${name}`,
          `Number: ${phone}`,
          str(body.area) ? `Area: ${str(body.area)}` : null,
          str(body.project_type) ? `Project: ${str(body.project_type)}` : null,
          `Booked: ${speak(d.start)}`,
          confirmedByPhone ? "Confirm by phone - no email given." : `Confirmation sent to ${email}`,
          str(body.handoff_note) ? `Note: ${str(body.handoff_note)}` : null,
        ].filter(Boolean);
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: `CONSULTATION BOOKED \u2014 Aangan Front Desk\n\n${lines.join("\n")}`,
          }),
        });
      }
    } catch { /* same: the booking stands either way */ }

    return json({
      booked: true,
      booking_uid: d.uid,
      consultation_at: d.start,
      confirmed_by_phone: confirmedByPhone,
      call_ref,
      logged,
      say: confirmedByPhone
        ? `Booked for ${speak(d.start)}. Tell the caller the designer will confirm on this number.`
        : `Booked for ${speak(d.start)}. Tell the caller a confirmation is on its way to their email.`,
      instruction: `Confirm the time to the caller. Then, before you hang up, call notify_designer with call_ref "${call_ref}" and the full handoff note.`,
    });
  }

  return json({ error: "action must be slots or book" }, 400);
});
