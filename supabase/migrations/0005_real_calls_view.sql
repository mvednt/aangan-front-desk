-- Test traffic from building this never belongs in the numbers Nikhil reads.
-- One place to define what counts as a real call, so the four panels cannot
-- drift apart. Deletes are gated on this project, so the rows stay and are
-- filtered here instead.
create or replace view v_real_calls as
select *
from calls
where call_ref not ilike '%test%'
  and call_ref not like 'auto-98765%'
  and call_ref not like 'PIPELINE-%'
  and coalesce(name, '') not ilike '%test%';

comment on view v_real_calls is
  'calls minus the rows created while building and testing. Every dashboard panel reads this, never calls directly.';

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
from v_real_calls
group by 1
order by 1 desc;

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
from v_real_calls
group by 1
order by 1 desc;

create or replace view v_decline_queue as
select started_at, name, area, project_type, decline_reason, criteria_failed,
       handoff_note, transcript_url
from v_real_calls
where verdict = 'declined'
  and started_at > now() - interval '7 days'
order by started_at desc;

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
from v_real_calls c cross join cost_config cfg
group by 1
order by 1 desc;

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
from v_real_calls c cross join cost_config cfg
group by 1
order by 1 desc;
