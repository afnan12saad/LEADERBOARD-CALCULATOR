# Rank Rush - Supabase Backend: Owner Setup & Handoff

This document is the exact onboarding and operations guide for the Supabase-backed
Rank Rush app (branch `supabase-rank-rush`). Nothing here deploys anything.

## What changed

- Backend moved from Firebase to Supabase (project "Rank Rush", free plan, Mumbai).
  The old Firebase project is untouched and can stay as-is or be removed later.
- Admin limit is exactly 2, enforced server-side (row lock + quota table), not just in the UI.
- Five-criteria scoring (0-5 each, total /25) is enforced by database CHECK constraints.
- Audience sees results only after an admin publishes them. The projector/live view is admin-only.

## Project facts

- Project URL: https://mmhtdzmamzqoazgbkmdg.supabase.co
- Dashboard: https://supabase.com/dashboard/project/mmhtdzmamzqoazgbkmdg
- The anon/publishable key in `src/services/supabaseClient.ts` is public by design
  (protected by row-level security). No secret keys are in this repo.
- Database password is in your Instinct vault ("Supabase Rank Rush Postgres").
- Schema of record: `supabase/schema.sql` (includes all applied migrations).

## First admin (you) - one-time secure binding

There is deliberately NO self-service way to become admin. Binding is a manual
owner step so nobody can claim the seat:

1. Open the app and create your account (Admin Login > Create Admin Account) with
   your own email and password.
2. Open the Supabase dashboard > Authentication > Users and copy your user's UID.
3. Open SQL Editor and run (replace the two placeholders):

   insert into public.admins (uid, email, name, is_first_admin)
   values ('YOUR_UID', 'you@example.com', 'Your Name', true);
   update public.admin_quota
   set count = 1, first_admin_email = 'you@example.com', first_admin_uid = 'YOUR_UID'
   where id = true;

4. Sign in at Admin Login. You now hold admin seat 1 of 2.

## Second admin - verified identity path

The second organizer must go through the in-app request -> approve flow:

1. She creates her account in the app and taps "Create Admin Account" to file a join request.
2. You approve it from the Admin Console (join requests panel). The cap of 2 is
   enforced by the database; a third approval fails even if two people click at once.

IDENTITY CAVEAT: do not treat a dashboard "confirm email" click as proof of her
identity. Bind the approval to her proven account (her UID, after you have
verified it is really her - e.g. she signs up while you watch, or confirms from
a channel you already trust).

## Email deliverability limits (free plan)

Supabase's built-in SMTP on the free plan only delivers to addresses of members
of your Supabase organization, at most 2 emails/hour
(https://supabase.com/docs/guides/auth/auth-smtp). Consequences:

- Your own signup confirmation and password-reset emails may not arrive.
  Workaround for the owner: dashboard > Authentication > Users > your user >
  confirm email / send recovery from there (owner action, not an identity check).
- For real deliverability (judges/admins getting emails), configure custom SMTP
  (dashboard > Project Settings > Authentication > SMTP) with any provider.
- Google sign-in is simply not configured (no OAuth client); it can be added later
  in dashboard > Authentication > Providers.

## Build & deploy (your call - nothing here runs a deploy)

- `npm install` then `npm run build` produces the static site in `dist/`.
- Any static host works (the app's only config is the public URL + anon key in
  `src/services/supabaseClient.ts`).
- Run unit tests with `npx tsx --test src/utils/scoring.test.ts`.
- `live-tests-f.mjs` and `live-tests-g.mts` are the live-backend regression
  suites (need a throwaway admin account; create one via dashboard Add User,
  bind it as above, delete after). Run F first, then G, against a clean project.

## Tested state at handoff

- 18/18 scoring unit tests (`npx tsx --test src/utils/scoring.test.ts`);
  `npm run lint` (tsc) + `npm run build` clean.
- 52 live assertions green against this project's final tree:
  - Suite F (10): archive+reset RPC rejects a stale snapshot, archives the event,
    reseeds 15 teams, clears scores, hides the leaderboard, resets settings/timer.
  - Suite G (42): every direct Data API write path the app uses, exercised through
    the app's own arenaService functions as a bound admin (settings, team
    create/update/delete, judge create/update/delete with evaluations, admin
    request reject, archive save, judge-count summary), plus migration-8
    evaluation insert/update; and denial proofs for the same tables as an
    anonymous judge session and a fully unauthenticated client.
  - Earlier suites (not re-runnable after harness cleanup, results recorded):
    RLS gating, judge registration/scoring flows, scoring constraints, admin-cap
    concurrency under parallel approval, publish + realtime + audience read.
- Live project left clean: 0 auth users, 0 admin bindings, 0 judges, 0 scores,
  0 requests, 0 archives, 15 seeded teams, results unpublished, timer zeroed.
  The first admin slot is yours: sign up in the app, then bind your UID with
  the SQL in the first-admin section above.
