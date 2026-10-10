-- Credentials the agent's own functions need (Telegram bot token, Cal.com key).
-- RLS on with no policies: service_role only. Nothing in the browser can read
-- this, and there is deliberately no read path exposed through any function.
--
-- Values are written once via the set-secret function and never travel through
-- the voice platform, which only ever holds the shared secret.
create table if not exists agent_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table agent_secrets enable row level security;

comment on table agent_secrets is
  'Third-party credentials for the Edge Functions. RLS on, no policies: service_role only.';
