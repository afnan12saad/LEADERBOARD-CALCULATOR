import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const URL = 'https://mmhtdzmamzqoazgbkmdg.supabase.co';
const ANON = 'sb_publishable_8-DehxwKB3GhCbNs-BrvHw_FFrbDkUe';
const adminPw = readFileSync('/tmp/test-admin-pw', 'utf8').trim();
const defaultTeams = JSON.parse(readFileSync('/tmp/default-teams.json', 'utf8'));
const ADMIN_UID = '9e6c11ae-7100-48f8-863f-ae398fe954c5';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

const admin = createClient(URL, ANON);
await admin.auth.signInWithPassword({ email: 'test-admin2@rankrush.test', password: adminPw });

const mkReq = async (email, pw) => {
  const c = createClient(URL, ANON);
  await c.auth.signInWithPassword({ email, password: pw });
  return c;
};
// F: archive + reset
{
  const { data: evals } = await admin.from('evaluations').select('id');
  const expected = evals.length;
  const entries = [{ teamId: 'team-01', teamName: 'Team 01', averageScore: 15, totalScore: 15, rank: 1, submissionCount: expected }];
  const base = { p_event_name: 'Rank Rush Test Event', p_archived_by: 'Test Admin', p_entries: entries,
    p_total_judges: 1, p_total_teams: 15, p_total_submissions: expected,
    p_default_teams: defaultTeams, p_settings: { timerDurationSeconds: 300 } };
  const r1 = await admin.rpc('archive_and_reset_event', { ...base, p_expected_evals: expected + 5 });
  ok('F1 stale snapshot rejected, nothing reset', !!r1.error && /ratings changed/.test(r1.error.message), JSON.stringify(r1.error));
  const stillThere = (await admin.from('evaluations').select('id')).data.length;
  ok('F2 evals intact after rejected reset', stillThere === expected, 'n=' + stillThere);
  const r2 = await admin.rpc('archive_and_reset_event', { ...base, p_expected_evals: expected });
  ok('F3 archive+reset succeeds', !r2.error && typeof r2.data === 'string', JSON.stringify(r2.error));
  const checks = await admin.from('evaluations').select('id');
  ok('F4 evaluations cleared', checks.data.length === 0, 'n=' + checks.data.length);
  const teams = await admin.from('teams').select('id');
  ok('F5 teams reseeded to 15', teams.data.length === 15, 'n=' + teams.data.length);
  const arch = await admin.from('event_archives').select('*');
  ok('F6 archive row saved', arch.data.length === 1 && arch.data[0].total_submissions === expected, JSON.stringify(arch.data));
  const anon = createClient(URL, ANON);
  const lb = await anon.from('public_leaderboard').select('*');
  ok('F7 leaderboard hidden again for audience', !lb.error && lb.data.length === 0, 'n=' + lb.data?.length);
  const archAnon = await anon.from('event_archives').select('*');
  ok('F8 archives not world-readable', !!archAnon.error || archAnon.data.length === 0, 'n=' + archAnon.data?.length);
  const settings = await admin.from('settings_event').select('results_published,submissions_open,timer_duration_seconds,timer_remaining_seconds');
  ok('F9 settings reset (unpublished, submissions open)', settings.data?.[0]?.results_published === false && settings.data?.[0]?.submissions_open === true, JSON.stringify(settings.data));
  ok('F10 timer duration+remaining restored together', settings.data?.[0]?.timer_duration_seconds === 300 && settings.data?.[0]?.timer_remaining_seconds === 300, JSON.stringify(settings.data));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
