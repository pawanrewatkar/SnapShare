-- Manual RLS verification script. Run against a LOCAL Supabase instance only (supabase start; psql).
-- It impersonates two users and an anonymous visitor and asserts isolation.
begin;

insert into public.profiles (id, email, name) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com', 'Alice'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com', 'Bob');
insert into public.media_assets (id, user_id, drive_file_id, filename, media_type, mime_type, size) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'drive-a', 'a.png', 'screenshot', 'image/png', 10),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'drive-b', 'b.png', 'screenshot', 'image/png', 10);
insert into public.google_credentials (user_id, refresh_token_ciphertext) values ('00000000-0000-0000-0000-00000000000a', 'secret');

-- Act as Alice
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$ begin
  if (select count(*) from public.media_assets) <> 1 then raise exception 'RLS FAIL: alice sees other users assets'; end if;
  if exists (select 1 from public.media_assets where user_id <> auth.uid()) then raise exception 'RLS FAIL: foreign asset visible'; end if;
end $$;

-- Alice cannot create a share link for Bob's asset
do $$ begin
  begin
    insert into public.share_links (asset_id, user_id, token_hash, token_ciphertext, access_type)
    values ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', repeat('a', 64), 'x', 'restricted');
    raise exception 'RLS FAIL: share link for foreign asset was inserted';
  exception when others then
    if sqlerrm like 'RLS FAIL%' then raise; end if;
  end;
end $$;

-- Alice cannot read credentials
do $$ begin
  begin
    perform 1 from public.google_credentials;
    raise exception 'RLS FAIL: credentials readable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Anonymous visitor sees nothing
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from public.media_assets;
    raise exception 'RLS FAIL: anon can read assets';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
select 'RLS checks passed' as result;
