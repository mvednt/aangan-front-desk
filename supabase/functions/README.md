# Supabase Edge Functions

Six functions sit between the voice agent and everything else. The agent never
holds a privileged credential: it sends a shared secret in `x-agent-secret`, and
the service-role key, the Telegram bot token, the Cal.com API key and the CRM
token all stay inside Supabase.

| Function | Called as | What it does |
|---|---|---|
| `lookup-caller` | `step0_lookup_caller` | Before the agent speaks: has this number called in the last 24h? Returns an instruction, not just data. |
| `book-consultation?action=slots` | `aangan_find_times` | Real Cal.com openings, already phrased for speech. |
| `book-consultation?action=book` | `aangan_hold_slot` | Holds the slot the caller picked. Also writes the lead log and pings Telegram. |
| `notify-designer` | `notify_designer` | Close-out: Telegram note, lead-log row, **and** CRM fan-out, in one call. |
| `cancel-booking` | (ops) | Releases a slot; `action: "list"` finds the uid. |
| `set-secret` | (ops) | Write-only credential drop into `agent_secrets`. No read path. |

## One tool per turn, and what it forces

Vaani reliably executes **one custom tool per conversational turn**. A second
call in the same turn is dropped silently.

That single fact shapes the whole backend. The original design called
`notify_designer` after the booking, and that second call kept losing its turn,
silently dropping the lead-log write — the one write that must never be dropped,
because it is what stops the same caller being opened as a new lead tomorrow.

So anything that must happen at the end of a call is **fanned out server-side
from one function** rather than added as another tool the agent has to remember.
`notify-designer` now does three things in one turn:

1. sends the handoff note to Telegram
2. writes the lead-log row
3. pushes a qualified lead to the CRM

Each leg is independent — Telegram can fail without taking down the log, and the
CRM can be absent entirely. The reply reports which legs ran. **Adding Slack,
WhatsApp or email later means another block in here, not another tool.**

`book-consultation` writes a row too, as a safety net for the booked path. Both
paths derive the same `call_ref`:

    auto-<last 10 digits>-<YYYY-MM-DD>

so one caller on one day is one row, whichever fires first. `notify-designer`
fills in what the booking could not know — verdict, timeline, decision maker,
what is still unknown — and only ever writes booleans when **true**, so arriving
second cannot quietly un-book a lead.

## The CRM leg

Dormant until `HUBSPOT_TOKEN` exists in `agent_secrets`, and silent when it does
not — an absent CRM is a normal state, not an error.

Only **qualified** leads are pushed. A decline belongs in the weekly review queue
in Postgres, not as clutter in the sales pipeline; an escalation is an existing
client who is already in the CRM, and creating a second record for them is worse
than creating none.

It searches contacts by phone before creating one, so a caller who rings back
twice does not become two contacts. The deal carries project type, size, area,
timeline and the handoff note — but **no amount**. The project value is not known
at the end of a first call, and inventing one would put fiction into the forecast.

Stage IDs are configurable (`HUBSPOT_PIPELINE`, `HUBSPOT_STAGE_BOOKED`,
`HUBSPOT_STAGE_QUALIFIED`) because they differ per account; the defaults match a
stock HubSpot pipeline.

## What testing actually found

Five bugs, none visible without running the thing end to end:

1. `lookup-caller` expected `caller_number`; the tool sends `number`. Step 0 was
   returning 400 on every single call. It now accepts either, and matches on the
   last ten digits so `+91 98…`, `098…` and `98…` are one caller.
2. Cal.com rejects non-E.164 numbers. `9822011234` failed every booking until it
   was normalised to `+919822011234`.
3. Cal.com also rejects undeliverable addresses, so the `.invalid` placeholder
   email never worked. Callers who will not give an email now book against the
   studio inbox and are told the designer will confirm by phone.
4. The one-tool-per-turn limit described above.
5. The close-out overwrote `booked = true` with `false`.

A sixth, found while wiring the CRM: redacting the Telegram chat ID out of the
source for this public repo also removed it from the deployed function, and the
handoff silently stopped sending. Configuration that was living in source now
lives in `agent_secrets` where it belongs.

## Secrets

`AGENT_SHARED_SECRET` is read from the function environment. Each function also
carries a fallback constant so the pipeline works before that is configured —
**those constants are redacted in this repository** and live only in the deployed
function source. Rotate by setting the env var; no redeploy needed.

The Telegram bot token, chat ID, Cal.com API key and HubSpot token are not in
this repo and never passed through the voice platform. They were written straight
into the `agent_secrets` table — RLS on, no policies, service-role only — via
`set-secret`, which has no read path by design.
