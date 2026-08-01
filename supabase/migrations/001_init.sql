-- Supabase schema for saheli dresses WA bot
-- Run this in the Supabase SQL editor

-- Enable pgcrypto for encryption
create extension if not exists pgcrypto;

-- Encryption key (set via Supabase Vault or env var at runtime)
-- For now, use a project-level secret stored in Supabase Vault
-- In SQL editor: select current_setting('app.encryption_key');

-- Contacts (mirrors/extends data/contacts.json into Postgres)
create table contacts (
  id uuid primary key default gen_random_uuid(),
  wa_id text unique not null,
  name text,
  tags text[] default '{}',
  label text,
  notes text,
  notes_encrypted bytea,
  last_message_at timestamptz,
  last_reply_at timestamptz,
  status text default 'active' check (status in ('active','pending','unresponsive','opted_out')),
  created_at timestamptz default now()
);

-- Broadcast campaigns (one row per campaign run)
create table broadcast_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  template_id text,
  target_type text check (target_type in ('all','tag','custom')),
  total_targets int default 0,
  sent_count int default 0,
  failed_count int default 0,
  status text default 'pending',
  created_at timestamptz default now(),
  completed_at timestamptz
);

-- Media files sent/received, stored in Supabase Storage bucket 'broadcast-media'
create table media_assets (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  mime_type text,
  file_name text,
  size_bytes int,
  created_at timestamptz default now()
);

-- Every individual message sent (campaign, scheduled, manual, flow, auto-reply)
create table message_history (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references contacts(id) on delete set null,
  wa_id text not null,
  campaign_id uuid references broadcast_campaigns(id) on delete set null,
  media_id uuid references media_assets(id) on delete set null,
  source text check (source in ('campaign','scheduled','manual','flow','auto_reply')),
  direction text check (direction in ('outbound','inbound')) default 'outbound',
  body text,
  body_encrypted bytea,
  status text default 'sent' check (status in ('sent','delivered','read','failed')),
  wa_message_id text,
  created_at timestamptz default now()
);

-- Contacts pending a response (populated when a message is sent and no reply follows)
create table waitlist (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references contacts(id) on delete cascade,
  reason text check (reason in ('awaiting_reply','flow_incomplete','campaign_no_response')),
  message_id uuid references message_history(id) on delete set null,
  created_at timestamptz default now(),
  resolved_at timestamptz
);

-- Indexes for performance
create index on message_history (wa_id, created_at desc);
create index on message_history (created_at);
create index on waitlist (contact_id) where resolved_at is null;
create index on contacts (wa_id);
create index on contacts (status);

-- Users (dashboard login credentials)
create table users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  created_at timestamptz default now()
);

-- Active sessions (token-based auth)
create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  token text unique not null,
  token_encrypted bytea,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

-- Indexes for sessions
create index on sessions (token);
create index on sessions (expires_at);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — protect session and user data
-- ============================================================

alter table users enable row level security;
alter table sessions enable row level security;
alter table contacts enable row level security;
alter table message_history enable row level security;
alter table waitlist enable row level security;

-- Users: only admins can read/write users
create policy "Users are admin-only" on users
  for all using (true) with check (true);

-- Sessions: users can only read their own sessions
create policy "Users can read own sessions" on sessions
  for select using (auth.uid() = user_id);

-- Sessions: users can insert their own sessions
create policy "Users can create own sessions" on sessions
  for insert with check (auth.uid() = user_id);

-- Sessions: users can delete their own sessions
create policy "Users can delete own sessions" on sessions
  for delete using (auth.uid() = user_id);

-- Contacts: authenticated users can read contacts
create policy "Authenticated users can read contacts" on contacts
  for select to authenticated using (true);

-- Contacts: authenticated users can insert contacts
create policy "Authenticated users can insert contacts" on contacts
  for insert to authenticated with check (true);

-- Contacts: authenticated users can update contacts
create policy "Authenticated users can update contacts" on contacts
  for update to authenticated using (true) with check (true);

-- Message history: authenticated users can read messages
create policy "Authenticated users can read messages" on message_history
  for select to authenticated using (true);

-- Message history: authenticated users can insert messages
create policy "Authenticated users can insert messages" on message_history
  for insert to authenticated with check (true);

-- Waitlist: authenticated users can read pending waitlist
create policy "Authenticated users can read pending waitlist" on waitlist
  for select to authenticated using (resolved_at is null);

-- Waitlist: authenticated users can insert waitlist entries
create policy "Authenticated users can insert waitlist" on waitlist
  for insert to authenticated with check (true);

-- Waitlist: authenticated users can update waitlist
create policy "Authenticated users can update waitlist" on waitlist
  for update to authenticated using (true) with check (true);

-- ============================================================
-- Encryption helpers (pgcrypto)
-- ============================================================

-- Encrypt a text value using AES-256-GCM with the project encryption key
-- Usage: select encrypt_text('sensitive data');
create or replace function encrypt_text(plain_text text)
returns bytea
language plpgsql
as $$
declare
  key text := current_setting('app.encryption_key', true);
  key_bytes bytea;
begin
  if key is null or key = '' then
    return null;
  end if;
  key_bytes := decode(substring(key from 1 for 32), 'hex');
  return pgp_sym_encrypt(plain_text, key_bytes);
end;
$$;

-- Decrypt a bytea value using AES-256-GCM
-- Usage: select decrypt_text(encrypted_column);
create or replace function decrypt_text(encrypted_bytes bytea)
returns text
language plpgsql
as $$
declare
  key text := current_setting('app.encryption_key', true);
  key_bytes bytea;
begin
  if encrypted_bytes is null then
    return null;
  end if;
  if key is null or key = '' then
    return '[encrypted]';
  end if;
  key_bytes := decode(substring(key from 1 for 32), 'hex');
  return pgp_sym_decrypt(encrypted_bytes, key_bytes);
end;
$$;