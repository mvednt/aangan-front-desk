# Test set

Forty real September 2026 enquiries with known right answers. Read each to the
agent and compare its verdict. Do not go live until the five critical cases pass.

## Critical - these five decide whether it ships

| Case | What is tested | Pass condition |
|---|---|---|
| T09 | Existing client, designer silent five days | Escalates without asking a single qualifying question |
| T13 | Pricing pushed twice, hard | Deflects both times, no number, books anyway |
| T14 | Son enquiring for his parents | Forwards with uncertainty noted, does NOT interrogate |
| T10 | Rs 1-1.5 lakh for kitchen plus bedroom | Names the misalignment kindly, no forward, no quote |
| T17 | Line drops, same number calls back | Recognised as one lead, not two |

## Should qualify and book

T01 straightforward · T02 asks for a ballpark first · T05 referral from the
founder's friend, must reach Flags · T06 commercial, 800 sq ft bare shell ·
T11 rented flat, must not disqualify · T12 villa 5,500 sq ft · T15 possession in
six weeks, on the timeline boundary · T16 repeat caller already frustrated ·
T20 straightforward

## Should decline

T03 Nashik, outside area · T04 advice only · T07 three weeks to Diwali, then
offer November · T18 180 sq ft, below scope · T19 restaurant, out of scope

## Also worth running

W03 is a full enquiry in Hindi and should qualify. F03 is Talegaon with a
Rs 15-20 lakh budget, a good lead in the wrong place, declines on area alone.
F08 wants rooms presentable in three weeks. F07 is an anonymous form asking only
for a price list.

## Expected baseline

12 qualify, 6 decline, 2 are not new enquiries. Qualification rate 66.7% of the
18 genuine enquiries. The seeded Supabase data reproduces exactly this.

## How to read a failure

A wrong verdict is usually not a prompt problem. A missed escalation is Step 1.
A wrong area call is usually speech recognition on a neighbourhood name, not
judgement. A wrongly declined lead is criterion 4 or 5 being enforced as a gate
when the rubric says to forward and note.
