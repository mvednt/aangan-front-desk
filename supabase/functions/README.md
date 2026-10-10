# Supabase Edge Functions

Four functions sit between the voice agent and everything else. The agent never
holds a privileged credential: it sends a shared secret in `x-agent-secret`, and
the service-role key, the Telegram bot token and the Cal.com API key all stay
inside Supabase.

| Function | Called as | What it does |
|---|---|---|
| `lookup-caller` | `step0_lookup_caller` | Before the agent speaks: has this number called in the last 24h? Returns an instruction, not just data. |
| `book-consultation?action=slots` | `aangan_find_times` | Real Cal.com openings, already phrased for speech. |
| `book-consultation?action=book` | `aangan_hold_slot` | Holds the slot the caller picked. Also writes the lead log and pings Telegram. |
| `notify-designer` | `notify_designer` | Close-out: handoff note to Telegram **and** the lead-log row, in one call. |
| `cancel-booking` | (ops) | Releases a slot; `action: "list"` finds the uid. |
| `set-secret` | (ops) | Write-only credential drop into `agent_secrets`. No read path. |

## Why the booking tool also writes the log

Vaani reliably executes **one custom tool per turn**. The original design called
`notify_designer` after the booking, and that second call kept losing its turn —
silently dropping the lead-log write, which is the one write that must never be
dropped, because it is what stops the same caller being opened as a new lead
tomorrow.

So the booking writes the row too. Both paths derive the same `call_ref` from the
caller's number and the date:

    auto-<last 10 digits>-<YYYY-MM-DD>

so one caller on one day is one row, whichever fires first. `notify-designer`
fills in what the booking could not know — verdict, timeline, decision maker,
what is still unknown — and only ever writes booleans when **true**, so arriving
second cannot quietly un-book a lead.

## What testing actually found

Five bugs, none of them visible without running the thing end to end:

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

## Secrets

`AGENT_SHARED_SECRET` is read from the function environment. Each function also
carries a fallback constant so the pipeline works before that is configured —
**those constants are redacted in this repository** and live only in the deployed
function source. Rotate by setting the env var; no redeploy needed.

The Telegram bot token and Cal.com API key are not in this repo and never passed
through the voice platform. They were written straight into the `agent_secrets`
table — RLS on, no policies, service-role only — via `set-secret`, which has no
read path by design.
