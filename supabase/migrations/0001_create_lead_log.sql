-- Aangan Front Desk: call log and state
-- One row per call. Rows are append-only; corrections go in a new row.

create type call_verdict as enum ('qualified', 'declined', 'escalated', 'not_an_enquiry', 'dropped');

create type decline_reason as enum (
  'out_of_area',
  'advice_only',
  'out_of_scope',
  'timeline_too_short',
  'budget_below_floor',
  'other'
);

create table calls (
  id                uuid primary key default gen_random_uuid(),
  call_ref          text unique not null,              -- platform call id
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  call_seconds      integer,

  -- who called
  caller_number     text not null,
  repeat_caller     boolean not null default false,
  prior_call_id     uuid references calls(id),         -- set when this continues an earlier call

  -- what they want
  name              text,
  area              text,
  project_type      text,
  size_sqft         integer,
  current_state     text,                              -- new possession / lived in / bare shell
  timeline          text,
  decision_maker    text,
  budget_mentioned  boolean not null default false,
  budget_note       text,
  source            text,

  -- what the agent decided
  verdict           call_verdict,
  decline_reason    decline_reason,
  criteria_failed   text[],                            -- which of the five, for the review queue
  escalated         boolean not null default false,

  -- what happened next
  booked            boolean not null default false,
  consultation_at   timestamptz,
  site_visit        boolean,
  attended          boolean,                           -- filled in later by a human

  -- artefacts
  handoff_note      text,
  transcript_url    text,
  flags             text,
  still_unknown     text,

  created_at        timestamptz not null default now()
);

-- Step 0 of the agent prompt: look up the inbound number before speaking.
create index calls_caller_number_started_at_idx
  on calls (caller_number, started_at desc);

create index calls_verdict_idx on calls (verdict);
create index calls_started_at_idx on calls (started_at desc);

comment on table calls is
  'One row per inbound call. Append-only: corrections are new rows linked by prior_call_id.';
comment on column calls.criteria_failed is
  'Which of Nikhil''s five criteria failed. Drives the weekly decline review.';
comment on column calls.attended is
  'Did the consultation actually happen. Filled by a human, not the agent.';
