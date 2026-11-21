import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const URL = 'https://mmhtdzmamzqoazgbkmdg.supabase.co';
const ANON = 'sb_publishable_8-DehxwKB3GhCbNs-BrvHw_FFrbDkUe';
const adminPw = readFileSync('/tmp/test-admin-pw', 'utf8').trim();
const req1Pw = readFileSync('/tmp/req1-pw', 'utf8').trim();
const req2Pw = readFileSync('/tmp/req2-pw', 'utf8').trim();
const defaultTeams = JSON.parse(readFileSync('/tmp/default-teams.json', 'utf8'));
const ADMIN_UID = '9e6c11ae-7100-48f8-863f-ae398fe954c5';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

const admin = createClient(URL, ANON);
await admin.auth.signInWithPassword({ email: 'test-admin@rankrush.test', password: adminPw });

const mkReq = async (email, pw) => {
  const c = createClient(URL, ANON);
  await c.auth.signInWithPassword({ email, password: pw });
  return c;
};
const req1 = await mkReq('requester1@rankrush.test', req1Pw);
const req2 = await mkReq('requester2@rankrush.test', req2Pw);
const req1Uid = (await req1.auth.getUser()).data.user.id;
const req2Uid = (await req2.auth.getUser()).data.user.id;

// E1: self-serve admin request insert
{
  const r1 = await req1.from('admin_requests').insert({ uid: req1Uid, email: 'requester1@rankrush.test', name: 'Requester One' });
  ok('E1 requester1 files admin request', !r1.error, JSON.stringify(r1.error));
  const r2 = await req2.from('admin_requests').insert({ uid: req2Uid, email: 'requester2@rankrush.test', name: 'Requester Two' });
  ok('E2 requester2 files admin request', !r2.error, JSON.stringify(r2.error));
  const r3 = await req1.from('admins').select('*');
  ok('E3 requester cannot list admins (own row only)', !r3.error && r3.data.every(a => a.uid === req1Uid), 'n=' + r3.data?.length);
}

// E2: concurrent approvals -> exactly one wins, cap = 2
{
  const [a, b] = await Promise.allSettled([
    admin.rpc('approve_admin_request', { p_uid: req1Uid, p_approved_by: 'Test Admin' }),
    admin.rpc('approve_admin_request', { p_uid: req2Uid, p_approved_by: 'Test Admin' }),
  ]);
  const okN = [a, b].filter(r => r.status === 'fulfilled' && !r.value.error).length;
  const capErr = [a, b].find(r => r.status === 'fulfilled' && r.value.error)?.value?.error?.message ?? '';
  ok('E4 concurrent approvals: exactly one succeeds', okN === 1, 'okN=' + okN);
  ok('E5 loser got cap error', /admin limit of 2 reached/.test(capErr), capErr);
  const { data: q } = await admin.from('admin_quota').select('*');
  ok('E6 quota count = 2 (max)', q?.[0]?.count === 2 && q?.[0]?.max_admins === 2, JSON.stringify(q));
}

// E3: retry of loser still blocked; non-admin approve blocked
{
  const loserUid = (await admin.from('admin_requests').select('uid,status').eq('status', 'pending')).data?.[0]?.uid;
  const r1 = await admin.rpc('approve_admin_request', { p_uid: loserUid, p_approved_by: 'Test Admin' });
  ok('E7 retry still blocked by cap', !!r1.error && /admin limit of 2/.test(r1.error.message), JSON.stringify(r1.error));
  const r2 = await req1.rpc('approve_admin_request', { p_uid: req2Uid, p_approved_by: 'x' });
  ok('E8 non-admin cannot approve', !!r2.error, 'no error!');
}

// E4: remove_admin rules
{
  const { data: admins } = await admin.from('admins').select('uid,is_first_admin');
  const second = admins.find(a => a.uid !== ADMIN_UID);
  const r1 = await admin.rpc('remove_admin', { p_uid: ADMIN_UID });
  ok('E9 cannot remove self/first admin', !!r1.error, 'no error!');
  const r2 = await admin.rpc('remove_admin', { p_uid: second.uid });
  ok('E10 remove second admin', !r2.error, JSON.stringify(r2.error));
  const { data: q } = await admin.from('admin_quota').select('count');
  ok('E11 quota count back to 1', q?.[0]?.count === 1, JSON.stringify(q));
  const r3 = await req1.rpc('remove_admin', { p_uid: ADMIN_UID });
  ok('E12 non-admin cannot remove', !!r3.error, 'no error!');
}

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
  const settings = await admin.from('settings_event').select('results_published,submissions_open');
  ok('F9 settings reset (unpublished, submissions open)', settings.data?.[0]?.results_published === false && settings.data?.[0]?.submissions_open === true, JSON.stringify(settings.data));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
