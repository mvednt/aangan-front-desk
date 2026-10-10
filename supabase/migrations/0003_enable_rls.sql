-- The agent writes through the service role (server side, never the browser).
-- The dashboard reads through its own server too. No anon access to call data:
-- these rows carry names, phone numbers and addresses.
alter table calls enable row level security;
alter table cost_config enable row level security;

-- No policies for anon or authenticated: service_role bypasses RLS, everything
-- else is denied by default. Add a policy here only when a real human login exists.

comment on table calls is
  'One row per inbound call. Append-only. RLS on with no public policies: service_role only.';
