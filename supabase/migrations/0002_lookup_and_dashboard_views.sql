-- Step 0 of the agent prompt: has this number called in the last 24 hours?
-- Returns the most recent prior call, or no rows. This is what stops T17
-- becoming two leads.
create or replace function recent_call_for(p_number text)
returns table (
  id uuid,
  started_at timestamptz,
  name text,
  area text,
  project_type text,
  verdict call_verdict,
  still_unknown text
)
language sql
stable
as $
  select c.id, c.started_at, c.name, c.area, c.project_type, c.verdict, c.still_unknown
  from calls c
  where c.caller_number = p_number
    and c.started_at > now() - interval '24 hours'
  order by c.started_at desc
  limit 1;
$;

comment on function recent_call_for is
  'Agent calls this before speaking. A row back means continue that lead, do not open a new one.';

-- Run cost. Vaani estimates Rs 5.98 per minute; subscription is monthly.
create table cost_config (
  id                   boolean primary key default true check (id),
  rupees_per_minute    numeric not null default 5.98,
  monthly_subscription numeric not null default 0,
  avg_project_value    numeric not null default 1100000,  -- midpoint of 8-14 lakh
  updated_at           timestamptz not null default now()
);
insert into cost_config (id) values (true);

comment on table cost_config is 'Single row. Edit here and the whole dashboard re-prices.';

-- Panel 1: did it answer?
create or replace view v_answering as
select
  date_trunc('month', started_at)                                   as month,
  count(*)                                                          as calls_handled,
  count(*) filter (where extract(hour from started_at at time zone 'Asia/Kolkata') < 10
                      or extract(hour from started_at at time zone 'Asia/Kolkata') >= 19)
                                                                    as out_of_hours,
  round(100.0 * count(*) filter (where extract(hour from started_at at time zone 'Asia/Kolkata') < 10
                                    or extract(hour from started_at at time zone 'Asia/Kolkata') >= 19)
        / nullif(count(*), 0), 1)                                   as pct_out_of_hours,
  count(*) filter (where verdict = 'dropped')                       as dropped
from calls
group by 1
order by 1 desc;

-- Panel 2: did it judge well?
create or replace view v_judgement as
select
  date_trunc('month', started_at)                                   as month,
  count(*) filter (where verdict = 'qualified')                     as qualified,
  count(*) filter (where verdict = 'declined')                      as declined,
  count(*) filter (where verdict = 'escalated')                     as escalated,
  count(*) filter (where repeat_caller)                             as repeat_callers,
  round(100.0 * count(*) filter (where verdict = 'qualified')
        / nullif(count(*) filter (where verdict in ('qualified','declined')), 0), 1)
                                                                    as qualification_rate_pct
from calls
group by 1
order by 1 desc;

-- The weekly review queue. Declines are the failures nobody complains about.
create or replace view v_decline_queue as
select started_at, name, area, project_type, decline_reason, criteria_failed,
       handoff_note, transcript_url
from calls
where verdict = 'declined'
  and started_at > now() - interval '7 days'
order by started_at desc;

-- Panel 3: did it convert?
create or replace view v_conversion as
select
  date_trunc('month', c.started_at)                                 as month,
  count(*) filter (where c.booked)                                  as booked,
  count(*) filter (where c.attended)                                as attended,
  round(100.0 * count(*) filter (where c.booked)
        / nullif(count(*) filter (where c.verdict = 'qualified'), 0), 1)
                                                                    as booking_rate_pct,
  round(100.0 * count(*) filter (where c.attended)
        / nullif(count(*) filter (where c.booked), 0), 1)           as show_up_rate_pct,
  count(*) filter (where c.attended) * max(cfg.avg_project_value)   as pipeline_value
from calls c cross join cost_config cfg
group by 1
order by 1 desc;

-- Panel 4: what did it cost, and the one ratio Nikhil watches.
create or replace view v_cost as
select
  date_trunc('month', c.started_at)                                 as month,
  round(sum(c.call_seconds) / 60.0, 1)                              as call_minutes,
  round(sum(c.call_seconds) / 60.0 * max(cfg.rupees_per_minute), 2) as voice_cost,
  max(cfg.monthly_subscription)                                     as subscription,
  round(sum(c.call_seconds) / 60.0 * max(cfg.rupees_per_minute)
        + max(cfg.monthly_subscription), 2)                         as total_run_cost,
  round((sum(c.call_seconds) / 60.0 * max(cfg.rupees_per_minute)
        + max(cfg.monthly_subscription))
        / nullif(count(*) filter (where c.verdict = 'qualified'), 0), 2)
                                                                    as cost_per_qualified_lead
from calls c cross join cost_config cfg
group by 1
order by 1 desc;
