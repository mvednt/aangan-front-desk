# Aangan Front Desk

A voice agent that answers Aangan Studio's phone line at any hour, qualifies new
interior-design enquiries against the founder's own rubric, books consultations,
and escalates existing-client complaints to a human.

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
| Voice, telephony, orchestration | Vaani Labs | agent live |
| Classification and routing | Gemini Flash | not set |
| Call log and state | Supabase | schema live |
| Booking | Cal.com | not wired |
| Designer handoff | Telegram | not wired |
| CRM | HubSpot | not wired |
| Dashboard hosting | Vercel | not built |

## Layout

    agent/system-prompt.md      agent instructions, v2 (byte-identical to deployed)
    agent/knowledge/            the three docs the agent retrieves
    supabase/migrations/        schema, Step 0 lookup, dashboard views
    docs/test-set.md            September transcripts as acceptance tests

## Why the prompt is version 2

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
declined T13 and T14. See docs/test-set.md.

## Known open question

services.md states no minimum office size. The front desk asserted a 500 sq ft
minimum on T18. The prompt currently enforces 500 sq ft. Confirm with the founder.
