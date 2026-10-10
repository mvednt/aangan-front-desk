# Aangan Front Desk

A voice agent that answers Aangan Studio's phone line at any hour, qualifies new
interior-design enquiries against the founder's own rubric, books consultations
into a real calendar, and escalates existing-client complaints to a human.

MESA AI and its Application · Founder's Office · Cohort C4 · Case 03

## The problem

Aangan Studio (Pune, 60 people, 14 designers) receives ~200 enquiries a month.
About 48% get no response within 48 hours. An enquiry answered within an hour
converts at **4x** the rate of one answered the next day. A third arrive outside
the front desk's 10am-7pm window. Average project value is Rs 8-14 lakh.

The silence is the largest revenue leak in the studio, and it is invisible
because nobody complains about a call that was never returned.

## The Cut

The founder asked for the agent to quote standard per-square-foot pricing.
His own pricing guide forbids it: "no number from this guide should be quoted
to a client." So the agent deflects every pricing question and books instead.

Transcripts T02 and T13 both show callers pushing hard for a number, being
refused, and booking anyway. The refusal costs nothing.

The price table is deliberately NOT in the agent's knowledge base, so it cannot
be retrieved and leaked on a call. Only the policy is.

## Stack

| Layer | Tool | Status |
|---|---|---|
| Qualification logic | Claude | done |
| Voice, telephony, orchestration | Vaani Labs | agent live, 4 tools attached |
| Call log and state | Supabase | live - schema, views, 6 edge functions |
| Booking | Cal.com | live - reads real openings, books them |
| Designer handoff | Telegram | live - bot sends the handoff note |
| Dashboard hosting | Vercel | live and public |
| CRM | HubSpot | built, dormant - awaiting a token |
| Classification and routing | Gemini Flash | not wired |

Live means tested end to end, not configured. The agent has read genuine
openings off Cal.com, held them, and written its own handoff notes to Telegram,
including an ESCALATE for an existing client raised without asking a single
qualification question.

**Not live: real phone calls.** No number is provisioned - Vaani KYC is pending
and a Karnataka DID is Rs 100 setup plus Rs 500/month. Everything is verified in
Vaani's tester and against the 40 September transcripts, not against real audio.

## How a call flows

1. `step0_lookup_caller` - before the agent speaks. Has this number called in
   the last 24 hours? Returns an instruction, not just data.
2. Qualify against the five criteria. Deflect every pricing question.
3. `aangan_find_times` - real Cal.com openings, already phrased for speech.
4. `aangan_hold_slot` - holds the slot the caller picked.
5. `notify_designer` - handoff note to Telegram **and** the lead-log row.

Because the platform runs **one tool per turn**, every downstream system is
fanned out server-side from that single close-out call rather than added as
another tool. The CRM leg is written and deployed but dormant: it stays silent
until a `HUBSPOT_TOKEN` is dropped into `agent_secrets`, and only qualified
leads are ever pushed - a decline belongs in the review queue, and an escalation
is an existing client already in the CRM.

The agent never holds a privileged credential. It sends a shared secret; the
service-role key, the Telegram bot token and the Cal.com API key all stay inside
Supabase. See `supabase/functions/README.md`.

## Layout

    agent/system-prompt.md      agent instructions (deployed version is v3)
    agent/knowledge/            the three docs the agent retrieves
    supabase/functions/         the six edge functions, and why they are shaped that way
    supabase/migrations/        schema, Step 0 lookup, dashboard views
    dashboard/                  the Vercel page
    docs/test-set.md            September transcripts as acceptance tests

## Why the prompt went to version 2

v1 was run against the five critical transcripts by an independent grader before
anything was deployed. It scored two clean passes, one pass that only worked by
breaking the pricing rule, and two outright failures:

- **T17** produced two lead records for one caller who rang back after a dropped
line. Nothing told the agent the lead log existed. Fixed by Step 0.
- **T14** was interrogated with four consecutive questions, because criterion 5
said "ask" while Step 4 said "do not push". Fixed by allowing exactly one
question.

The grader also found the budget rule both contradicted the no-numbers policy
and was too vague to act on, and that the timeline rule as written would have
declined T13 and T14. See `docs/test-set.md`.

## Why it went to version 3

Wiring the live tools found five bugs that no amount of reading would have:

1. `lookup-caller` expected `caller_number`; the tool sends `number`. Step 0 was
   returning 400 on **every** call.
2. Cal.com rejects non-E.164 numbers, so every booking failed until Indian
   10-digit numbers were normalised to `+91…`.
3. Cal.com also rejects undeliverable addresses, so the placeholder-email
   fallback never worked. Callers who will not give an email now book against
   the studio inbox and are confirmed by phone.
4. **Vaani runs one custom tool per turn.** The closing call kept losing its
   turn, silently dropping the lead-log write - the one write that must never be
   dropped. The log was merged into `notify_designer`, and the booking writes a
   row too. Both derive the same `call_ref`, so one caller on one day is one row.
5. The close-out was overwriting `booked = true` with `false`. Booleans are now
   only ever written when true.

## Known open question

`services.md` states no minimum office size. The front desk asserted a 500 sq ft
minimum on T18. The prompt currently enforces 500 sq ft. Confirm with the founder.
