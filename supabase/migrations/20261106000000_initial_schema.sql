-- SnapShare initial schema.
-- Media files live in each user's Google Drive; this database stores metadata only.
-- The Next.js backend uses the service role (server-side only) and enforces ownership in code.
-- RLS is enabled everywhere as defence in depth: authenticated users (JWT sub = profiles.id) can
-- only ever see their own rows; anon has no access; credential tables have no policies at all.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------- helpers ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  name text check (char_length(name) <= 200),
  avatar_url text check (char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();

-- ---------- google accounts (non-secret identity link) ----------
create table public.google_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  google_sub text not null unique check (char_length(google_sub) between 1 and 255),
  email citext not null,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger google_accounts_updated_at before update on public.google_accounts for each row execute function public.set_updated_at();

-- ---------- google credentials (SECRET: encrypted refresh token, service role only) ----------
create table public.google_credentials (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  refresh_token_ciphertext text not null,
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger google_credentials_updated_at before update on public.google_credentials for each row execute function public.set_updated_at();

-- ---------- sessions (extension sessions; service role only) ----------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text check (char_length(user_agent) <= 512)
);
create index sessions_user_idx on public.sessions(user_id);

-- ---------- one-time auth codes (PKCE between extension and backend; service role only) ----------
create table public.auth_codes (
  code_hash text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  code_challenge text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_codes_expires_idx on public.auth_codes(expires_at);

-- ---------- drive folders ----------
create table public.drive_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  folder_type text not null check (folder_type in ('root', 'screenshots', 'edited', 'videos')),
  drive_folder_id text not null check (char_length(drive_folder_id) between 1 and 255),
  created_at timestamptz not null default now(),
  unique (user_id, folder_type)
);

-- ---------- media assets ----------
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  drive_file_id text not null check (char_length(drive_file_id) between 1 and 255),
  filename text not null check (char_length(filename) between 1 and 200),
  media_type text not null check (media_type in ('screenshot', 'edited', 'video')),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'video/webm')),
  size bigint not null check (size > 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  parent_asset_id uuid references public.media_assets(id) on delete set null,
  status text not null default 'available' check (status in ('available', 'missing')),
  is_drive_public boolean not null default false,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, drive_file_id)
);
create index media_assets_user_created_idx on public.media_assets(user_id, created_at desc);
create index media_assets_user_type_idx on public.media_assets(user_id, media_type);
create trigger media_assets_updated_at before update on public.media_assets for each row execute function public.set_updated_at();

-- ---------- share links ----------
create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- SHA-256 of the random token: lookups never need the raw token.
  token_hash text not null unique check (char_length(token_hash) = 64),
  -- AES-256-GCM ciphertext so the owner can copy the link again; key lives only in server env.
  token_ciphertext text not null,
  access_type text not null check (access_type in ('public', 'restricted')),
  allow_download boolean not null default true,
  expires_at timestamptz,
  is_active boolean not null default true,
  revoked_at timestamptz,
  drive_permission_id text,
  view_count integer not null default 0,
  last_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > created_at)
);
create index share_links_asset_idx on public.share_links(asset_id);
create index share_links_user_idx on public.share_links(user_id);
create index share_links_expiry_idx on public.share_links(expires_at) where is_active;

-- Share links must belong to the owner of the asset.
create or replace function public.share_links_owner_check() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from public.media_assets a where a.id = new.asset_id and a.user_id = new.user_id) then
    raise exception 'share link owner must own the asset';
  end if;
  return new;
end $$;
create trigger share_links_owner before insert or update on public.share_links for each row execute function public.share_links_owner_check();

-- ---------- activity logs ----------
create table public.activity_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null check (char_length(action) <= 64),
  asset_id uuid references public.media_assets(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index activity_logs_user_idx on public.activity_logs(user_id, created_at desc);

-- ---------- rate limiting (fixed window counters) ----------
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  c integer;
begin
  insert into public.rate_limits(key, window_start, count) values (p_key, w, 1)
  on conflict (key, window_start) do update set count = public.rate_limits.count + 1
  returning count into c;
  -- opportunistic cleanup of old windows
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return c <= p_max;
end $$;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;

create or replace function public.increment_share_view(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.share_links set view_count = view_count + 1, last_viewed_at = now() where id = p_id;
$$;
revoke all on function public.increment_share_view(uuid) from public, anon, authenticated;

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.google_accounts enable row level security;
alter table public.google_credentials enable row level security;
alter table public.sessions enable row level security;
alter table public.auth_codes enable row level security;
alter table public.drive_folders enable row level security;
alter table public.media_assets enable row level security;
alter table public.share_links enable row level security;
alter table public.activity_logs enable row level security;
alter table public.rate_limits enable row level security;

-- Owner policies (authenticated role; auth.uid() = profiles.id). No anon policies exist:
-- public share access always goes through the backend, which validates the hashed token.
create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy google_accounts_select_own on public.google_accounts for select to authenticated using (user_id = auth.uid());

create policy drive_folders_all_own on public.drive_folders for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy media_assets_select_own on public.media_assets for select to authenticated using (user_id = auth.uid());
create policy media_assets_insert_own on public.media_assets for insert to authenticated with check (user_id = auth.uid());
create policy media_assets_update_own on public.media_assets for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy media_assets_delete_own on public.media_assets for delete to authenticated using (user_id = auth.uid());

create policy share_links_select_own on public.share_links for select to authenticated using (user_id = auth.uid());
create policy share_links_insert_own on public.share_links for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.media_assets a where a.id = asset_id and a.user_id = auth.uid()));
create policy share_links_update_own on public.share_links for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy share_links_delete_own on public.share_links for delete to authenticated using (user_id = auth.uid());

create policy activity_logs_select_own on public.activity_logs for select to authenticated using (user_id = auth.uid());

-- google_credentials, sessions, auth_codes, rate_limits: intentionally NO policies (service role only).
-- Belt and braces: remove direct privileges on secret tables from client roles.
revoke all on public.google_credentials, public.sessions, public.auth_codes, public.rate_limits from anon, authenticated;
revoke all on all tables in schema public from anon;
