-- ============================================================
-- 030_sleep_timer_events.sql
--
-- DEPLOY-1 (Part A): keep the SLEEP-1 sleep timer events. The client has
-- logged sleep_timer_set (meta.option) and sleep_timer_fired (meta.option,
-- meta.action) through the existing logActivity() since SLEEP-1, but the
-- check constraint below did not list them, so they were never stored.
--
-- Two event types added, nothing else. RLS is NOT changed: no policy is
-- added, dropped or altered, and no function is created or recreated (so
-- no grants change either). The rows go through the same Worker POST
-- /event path as every other type (worker/src/index.js
-- ACTIVITY_EVENT_TYPES, updated in the same commit): device_id or the
-- verified account id, and city-level location only.
-- ============================================================

alter table public.activity_events drop constraint activity_events_event_type_check;
alter table public.activity_events add constraint activity_events_event_type_check
  check (event_type = any (array[
    'page_view', 'play_start', 'play_25', 'play_50', 'play_75', 'play_complete',
    'heart', 'unheart', 'rate', 'comment', 'follow', 'unfollow', 'share', 'search',
    'sign_in', 'sign_up', 'upload_submit', 'dedication', 'idea_submit', 'idea_heart',
    'idea_status_change', 'profile_view',
    'sleep_timer_set', 'sleep_timer_fired'
  ]));
