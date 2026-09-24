-- ============================================================
-- 015_daily_report.sql — the daily digest, and the contribute-CTA switch
--
-- build_daily_report() assembles the last 24 hours as one jsonb document.
-- It is SECURITY DEFINER because it reads auth.users (sign-ups) and every
-- artist's submission_events, which no client role can see directly.
--
-- WHO MAY CALL IT: an admin session, or the service role (the Worker's
-- scheduled job, whose key lives only as a Wrangler secret). The service-role
-- check reads the JWT claims GUC, NOT current_user: inside a definer function
-- current_user is the owner, so a current_user test would either always pass
-- or never pass. The claims GUC is set by PostgREST per request and survives
-- definer. Anyone else gets a raise, and the function is revoked from public.
--
-- HOUSE RULE KEPT: positions and counts only. No raw play or heart number
-- appears anywhere in the document.
--
-- ALSO HERE (Step 4): contribute_cta_enabled, the homepage "Share your music"
-- switch, moved out of a code constant so the owner flips it in the Table
-- Editor with no deploy. Seeded false; the owner turns it on AFTER signup.
-- ============================================================

insert into public.site_settings (key, value) values
  ('contribute_cta_enabled', to_jsonb(false))
on conflict (key) do nothing;

create or replace function public.build_daily_report()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_role    text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_since   timestamptz := now() - interval '24 hours';
  v_cap     int;
  v_out     jsonb;
begin
  if not (public.is_admin() or v_role = 'service_role') then
    raise exception 'Only an admin or the report job can build the daily report.';
  end if;

  select coalesce((select (value #>> '{}')::int from public.site_settings where key='submit_max_per_day'), 5)
    into v_cap;

  select jsonb_build_object(
    'generated_at', now(),
    'window_hours', 24,

    'signups', (
      select jsonb_build_object(
        'count', count(*),
        'list', coalesce(jsonb_agg(jsonb_build_object(
                   'handle', a.handle, 'name', a.display_name, 'created_at', u.created_at)
                 order by u.created_at desc), '[]'::jsonb))
        from auth.users u
        left join public.artists a on a.id = u.id
       where u.created_at >= v_since
    ),

    'review_queue', (
      select jsonb_build_object(
        'count', count(*),
        'list', coalesce(jsonb_agg(jsonb_build_object(
                   'title', coalesce(nullif(s.title_translit,''), s.title),
                   'artist', a.handle, 'submitted_at', s.submitted_at)
                 order by s.submitted_at asc), '[]'::jsonb))
        from public.songs s
        left join public.artists a on a.id = s.artist_id
       where s.status = 'submitted'
    ),

    'pending_comments', (
      select count(*) from public.comments where status = 'pending'
    ),

    -- Proposed tags not yet in the vocabulary. "The vocabulary" is every tag
    -- already carried by an approved song, which is the only tag set the
    -- public ever sees.
    'proposed_tags_new', (
      select coalesce(jsonb_agg(distinct t), '[]'::jsonb)
        from public.songs s, unnest(s.proposed_tags) as t
       where s.status = 'submitted'
         and t <> ''
         and not exists (
           select 1 from public.songs v, unnest(v.tags) as vt
            where v.status = 'approved' and lower(vt) = lower(t))
    ),

    'anomalies', jsonb_build_object(
      -- The cap makes exceeding it impossible, so "over" should always be
      -- empty; "at_cap" is the early-warning list of accounts pushing the
      -- limit hard.
      'submissions_cap', v_cap,
      'submitters_at_or_over_cap', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'handle', a.handle, 'submissions_24h', x.n, 'over_cap', x.n > v_cap)
               order by x.n desc), '[]'::jsonb)
          from (select artist_id, count(*) as n
                  from public.submission_events
                 where created_at >= v_since
                 group by artist_id
                having count(*) >= v_cap) x
          join public.artists a on a.id = x.artist_id
      ),
      'ratings_from_young_accounts', (
        select jsonb_build_object(
          'count', count(*),
          'songs', coalesce(jsonb_agg(distinct coalesce(nullif(s.title_translit,''), s.title)), '[]'::jsonb))
          from public.ratings r
          join auth.users u on u.id = r.artist_id
          join public.songs s on s.id = r.song_id
         where r.created_at >= v_since
           and u.created_at > now() - interval '7 days'
      )
    ),

    -- The latest plays chart: titles by position, never the play numbers.
    'chart', (
      select jsonb_build_object(
        'chart_date', max(c.chart_date),
        'top10', coalesce((
          select jsonb_agg(jsonb_build_object('rank', c2.rank, 'title', c2.title) order by c2.rank)
            from public.chart_snapshots c2
           where c2.kind = 'plays'
             and c2.chart_date = (select max(chart_date) from public.chart_snapshots where kind='plays')
        ), '[]'::jsonb))
        from public.chart_snapshots c where c.kind = 'plays'
    )
  ) into v_out;

  return v_out;
end;
$fn$;

revoke all on function public.build_daily_report() from public;
grant execute on function public.build_daily_report() to authenticated, service_role;

-- 015b (applied separately): belt and braces on the outer layer.
revoke all on function public.build_daily_report() from anon;
