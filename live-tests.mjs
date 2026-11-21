import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const URL = 'https://mmhtdzmamzqoazgbkmdg.supabase.co';
const ANON = 'sb_publishable_8-DehxwKB3GhCbNs-BrvHw_FFrbDkUe';
const pw = readFileSync('/tmp/test-admin-pw', 'utf8').trim();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

// ---------- A: unauthenticated ----------
const anon = createClient(URL, ANON);
{
  const { data, error } = await anon.from('public_leaderboard').select('*');
  ok('A1 anon cannot read unpublished leaderboard', !error && data.length === 0, JSON.stringify({ error, n: data?.length }));
  const r2 = await anon.from('evaluations').select('*');
  ok('A2 anon cannot read evaluations', !!r2.error || r2.data.length === 0, 'read ok n=' + r2.data?.length);
  const r3 = await anon.from('teams').insert({ id: 'team-hack', name: 'hack', project_title: 'x', description: '' });
  ok('A3 anon cannot insert teams', !!r3.error, JSON.stringify(r3.data));
  const r4 = await anon.from('settings_event').update({ event_name: 'Hacked' }).eq('id', true).select();
  ok('A4 anon cannot update settings', !!r4.error || r4.data.length === 0);
  const r5 = await anon.from('judges').select('*');
  ok('A5 anon cannot read judges', !!r5.error || r5.data.length === 0, 'read ok n=' + r5.data?.length);
}

// ---------- B: anonymous judge ----------
const judgeClient = createClient(URL, ANON);
let judgeId;
{
  const { data: s, error: se } = await judgeClient.auth.signInAnonymously();
  ok('B1 anonymous sign-in', !se && !!s.session, JSON.stringify(se));
  const { data: j, error: je } = await judgeClient.rpc('register_judge', { p_name: 'Judge One', p_email: 'judge1@rankrush.test' });
  ok('B2 register_judge', !je && j?.id, JSON.stringify(je));
  judgeId = j?.id;
  console.log('  judgeId =', judgeId);
  const good = { c1: 5, c2: 4, c3: 3, c4: 2, c5: 1 };
  const r1 = await judgeClient.rpc('submit_score', { p_judge_id: judgeId, p_team_id: 'team-01', p_criteria: good, p_comment: 'good' });
  ok('B3 submit valid score', !r1.error, JSON.stringify(r1.error));
  const bad = { c1: 9, c2: 4, c3: 3, c4: 2, c5: 1 };
  const r2 = await judgeClient.rpc('submit_score', { p_judge_id: judgeId, p_team_id: 'team-02', p_criteria: bad, p_comment: '' });
  ok('B4 reject out-of-range criterion', !!r2.error, 'no error!');
  const badShape = { c1: 1, c2: 2, c3: 3 };
  const r3 = await judgeClient.rpc('submit_score', { p_judge_id: judgeId, p_team_id: 'team-02', p_criteria: badShape, p_comment: '' });
  ok('B5 reject 3-criteria shape', !!r3.error, 'no error!');
  const r4 = await judgeClient.from('evaluations').select('*');
  ok('B6 judge reads only own evaluations', !r4.error && r4.data.length === 1 && r4.data[0].judge_id === judgeId, 'n=' + r4.data?.length);
  const r5 = await judgeClient.from('teams').select('id').limit(3);
  ok('B7 judge can read teams', !r5.error && r5.data.length > 0, JSON.stringify(r5.error));
  const r6 = await judgeClient.from('judges').insert({ id: 'JHACK', judge_code: 'JHACK', name: 'x', department: '', email: 'x@x.co', active: true });
  ok('B8 judge cannot insert judges', !!r6.error, 'no error!');
  // other judge's ownership check
  const other = createClient(URL, ANON);
  await other.auth.signInAnonymously();
  const r7 = await other.rpc('submit_score', { p_judge_id: judgeId, p_team_id: 'team-03', p_criteria: good, p_comment: '' });
  ok('B9 other anon UID cannot submit as judge', !!r7.error, 'no error!');
}

// ---------- C: admin ----------
const admin = createClient(URL, ANON);
{
  const { data: s, error: se } = await admin.auth.signInWithPassword({ email: 'test-admin@rankrush.test', password: pw });
  ok('C1 admin sign-in', !se && !!s.session, JSON.stringify(se));
  const r1 = await admin.from('evaluations').select('*');
  ok('C2 admin reads all evaluations', !r1.error && r1.data.length >= 1, JSON.stringify(r1.error));
  const r2 = await admin.from('judges').select('*');
  ok('C3 admin reads judges', !r2.error && r2.data.length >= 1);
  const r3 = await admin.from('admins').insert({ uid: '00000000-0000-0000-0000-000000000000', email: 'x@x.co', name: 'x' });
  ok('C4 direct insert into admins denied', !!r3.error, 'no error!');
}

// ---------- D: realtime + publish + audience read ----------
{
  let rtEvent = null;
  const ch = anon.channel('lb-watch')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'public_leaderboard' }, p => { rtEvent = p; })
    .subscribe();
  await new Promise(r => setTimeout(r, 2500));
  const entries = [{ teamId: 'team-01', teamName: 'Team 01', averageScore: 15, totalScore: 15, rank: 1, submissionCount: 1 }];
  const r1 = await admin.rpc('publish_results', { p_publish: true, p_total_judges: 1, p_total_teams: 15, p_total_submissions: 1, p_entries: entries });
  ok('D1 publish_results', !r1.error, JSON.stringify(r1.error));
  await new Promise(r => setTimeout(r, 3000));
  ok('D2 realtime event fired on publish', rtEvent !== null, 'no event received');
  const r2 = await anon.from('public_leaderboard').select('*');
  ok('D3 audience reads published leaderboard', !r2.error && r2.data.length === 1 && r2.data[0].published === true, JSON.stringify({ error: r2.error, n: r2.data?.length }));
  const r3 = await anon.from('evaluations').select('*');
  ok('D4 evaluations stay hidden after publish', !!r3.error || r3.data.length === 0, 'read ok n=' + r3.data?.length);
  await anon.removeChannel(ch);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
