// Suite G: direct Data API write paths covered by migration-7 table grants.
// Positive tests call the app's own arenaService functions as a bound admin.
// Negative tests attempt the same tables as an anonymous judge session and as
// a fully unauthenticated client; RLS must still deny every one of them.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { supabase } from './src/services/supabaseClient';
import {
  saveEventSettings,
  saveTeamRecord,
  deleteTeamAndEvaluations,
  saveJudgeRecord,
  deleteJudgeAndEvaluations,
  rejectAdminJoinRequest,
  archiveCurrentEventResults,
  syncJudgeCountSummary,
} from './src/services/arenaService';

const URL = 'https://mmhtdzmamzqoazgbkmdg.supabase.co';
const ANON = 'sb_publishable_8-DehxwKB3GhCbNs-BrvHw_FFrbDkUe';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra ?? ''); }
}

const pw = readFileSync('/tmp/test-admin5-pw', 'utf8').trim();
const { error: se } = await supabase.auth.signInWithPassword({ email: 'test-admin5@rankrush.dev', password: pw });
if (se) { console.error('admin signin failed', se.message); process.exit(1); }
const me = (await supabase.auth.getUser()).data.user!;

// pre-clean leftovers from any prior partial run (evaluations cascade on judge delete)
await supabase.from('judges').delete().eq('email', 'g-judge@rankrush.dev');
await supabase.from('judges').delete().eq('id', 'J_G_NEG');
await supabase.from('teams').delete().eq('id', 'g-neg-team');

const { data: srow } = await supabase.from('settings_event').select('*').single();
const settings = {
  eventName: srow.event_name,
  collegeName: srow.college_name,
  tagline: srow.tagline,
  venue: srow.venue,
  eventDate: srow.event_date,
  customDomain: srow.custom_domain,
  submissionsOpen: srow.submissions_open,
  editingAllowed: srow.editing_allowed,
  resultsPublished: srow.results_published,
  tieBreakerMode: srow.tie_breaker_mode,
  currentTeamId: srow.current_team_id,
  timerDurationSeconds: srow.timer_duration_seconds,
  timerWarningSeconds: srow.timer_warning_seconds,
  timerRemainingSeconds: srow.timer_remaining_seconds,
  timerRunning: srow.timer_running,
  timerStartedAtMs: srow.timer_started_at_ms,
} as const;

// ---- G1: settings_event update via the app path ----
await saveEventSettings({ ...settings, tagline: 'G-TEST TAGLINE' });
const g1a = (await supabase.from('settings_event').select('tagline').single()).data?.tagline;
ok('G1 admin saveEventSettings persists', g1a === 'G-TEST TAGLINE', g1a);
await saveEventSettings({ ...settings });
const g1b = (await supabase.from('settings_event').select('tagline').single()).data?.tagline;
ok('G1b settings restored to original', g1b === settings.tagline, g1b);

// ---- G2/G3/G4: teams insert, update, delete via the app path ----
const tid = await saveTeamRecord({ name: 'Team 99 G-Test', projectTitle: 'G Test Project', description: 'g-suite', presentationStatus: 'Waiting' });
const g2 = (await supabase.from('teams').select('id').eq('id', tid).maybeSingle()).data;
ok('G2 admin saveTeamRecord inserts team', !!g2, tid);
await saveTeamRecord({ existingTeam: { id: tid } as never, name: 'Team 99 G-Test', projectTitle: 'G Test Project v2', description: 'g-suite', presentationStatus: 'Waiting' });
const g3 = (await supabase.from('teams').select('project_title').eq('id', tid).single()).data?.project_title;
ok('G3 admin saveTeamRecord updates team', g3 === 'G Test Project v2', g3);
await deleteTeamAndEvaluations(tid);
const g4 = (await supabase.from('teams').select('id').eq('id', tid).maybeSingle()).data;
ok('G4 admin deleteTeamAndEvaluations removes team', !g4);
const g4b = (await supabase.from('teams').select('id', { count: 'exact', head: true })).count;
ok('G4b teams back to 15', g4b === 15, g4b);

// ---- G5/G6/G7: judges insert, update, evaluations+judges delete via the app path ----
await saveJudgeRecord({ name: 'G Judge', email: 'g-judge@rankrush.dev', active: true });
const gj = (await supabase.from('judges').select('*').eq('email', 'g-judge@rankrush.dev').maybeSingle()).data;
ok('G5 admin saveJudgeRecord inserts judge', !!gj);
await saveJudgeRecord({ existingJudge: { id: gj.id } as never, name: 'G Judge Renamed', email: 'g-judge@rankrush.dev', active: true });
const g6 = (await supabase.from('judges').select('name').eq('id', gj.id).single()).data?.name;
ok('G6 admin saveJudgeRecord updates judge', g6 === 'G Judge Renamed', g6);
const { error: gEvalErr } = await supabase.from('evaluations').insert({
  id: `${gj.id}_team-01`, judge_id: gj.id, judge_uid: me.id, team_id: 'team-01',
  criteria: { c1: 4, c2: 4, c3: 4, c4: 4, c5: 4 },
  total: 20, score_version: 2, comment: '',
});
ok('G7a admin can insert evaluation row (migration 8)', !gEvalErr, gEvalErr?.message);
if (!gEvalErr) {
  const { error: gUpdErr } = await supabase.from('evaluations').update({ comment: 'g-updated' }).eq('id', `${gj.id}_team-01`);
  ok('G7a2 admin can update evaluation row (migration 8)', !gUpdErr, gUpdErr?.message);
}
await deleteJudgeAndEvaluations(gj.id);
const g7b = (await supabase.from('judges').select('id').eq('id', gj.id).maybeSingle()).data;
const g7c = (await supabase.from('evaluations').select('id').eq('judge_id', gj.id).maybeSingle()).data;
ok('G7b admin deleteJudgeAndEvaluations removes judge + evaluations', !g7b && !g7c);

// ---- G8: admin_requests reject via the app path ----
const reqClient = createClient(URL, ANON);
await reqClient.auth.signInAnonymously();
const reqUid = (await reqClient.auth.getUser()).data.user!.id;
const { error: reqErr } = await reqClient.from('admin_requests').insert({ uid: reqUid, email: 'g-req@rankrush.dev', name: 'G Requester', status: 'pending' });
ok('G8a requester can file own admin request', !reqErr, reqErr?.message);
await rejectAdminJoinRequest(reqUid);
const g8 = (await supabase.from('admin_requests').select('status').eq('uid', reqUid).single()).data?.status;
ok('G8 admin rejectAdminJoinRequest updates request', g8 === 'rejected', g8);

// ---- G9: event_archives insert via the app path ----
const archId = await archiveCurrentEventResults({ settings: settings as never, teams: [], judges: [], evaluations: [], archivedBy: 'g-suite' });
const g9 = (await supabase.from('event_archives').select('id').eq('id', archId).maybeSingle()).data;
ok('G9 admin archiveCurrentEventResults inserts archive', !!g9, archId);

// ---- G10: public_summary update via the app path ----
await syncJudgeCountSummary(7);
const g10 = (await supabase.from('public_summary').select('total_judges').single()).data?.total_judges;
ok('G10 admin syncJudgeCountSummary updates summary', g10 === 7, g10);
await syncJudgeCountSummary(0);

// ---- negatives: anonymous judge session ----
const j = createClient(URL, ANON);
await j.auth.signInAnonymously();
const jUid = (await j.auth.getUser()).data.user!.id;
await j.from('judges').insert({ id: 'J_G_NEG', judge_code: 'J_G_NEG', uid: jUid, name: 'Neg Judge', email: 'g-neg@rankrush.dev', department: '', active: true });

const n1 = await j.from('settings_event').update({ tagline: 'HACKED' }).eq('id', true).select();
ok('G11 judge settings update denied (0 rows)', (n1.data ?? []).length === 0, n1.error?.message);
const n1b = (await supabase.from('settings_event').select('tagline').single()).data?.tagline;
ok('G11b tagline unchanged after judge attempt', n1b === settings.tagline, n1b);

const n2 = await j.from('teams').insert({ id: 'team_hack', name: 'Hack', project_title: 'x', description: '', logo_url: '', presentation_status: 'Waiting', order_index: 99, tie_breaker_rank: 99 });
ok('G12 judge teams insert denied', !!n2.error, n2.error?.message);

const n3 = await j.from('teams').delete().eq('id', 'team-01').select();
ok('G13 judge teams delete denied (0 rows)', (n3.data ?? []).length === 0 && !n3.error, n3.error?.message);
ok('G13b team-01 intact', !!(await supabase.from('teams').select('id').eq('id', 'team-01').maybeSingle()).data);

const n4 = await j.from('judges').delete().eq('id', 'J_G_NEG').select();
ok('G14 judge cannot delete even own judges row', (n4.data ?? []).length === 0 && !n4.error, n4.error?.message);
ok('G14b neg judge row intact', !!(await supabase.from('judges').select('id').eq('id', 'J_G_NEG').maybeSingle()).data);

const n5 = await j.from('judges').update({ name: 'Renamed By Judge' }).eq('email', 'g-req@rankrush.dev').select();
ok('G15 judge cannot update another judges row', (n5.data ?? []).length === 0 && !n5.error, n5.error?.message);

const n6 = await j.from('evaluations').delete().eq('team_id', 'team-01').select();
ok('G16 judge evaluations delete denied (0 rows)', (n6.data ?? []).length === 0 && !n6.error, n6.error?.message);

// ---- migration-8 evaluations direct-write surface: judge positives + denials ----
const liveSet = (await supabase.from('settings_event').select('submissions_open, editing_allowed').single()).data!;
if (!liveSet.submissions_open) await saveEventSettings({ ...settings, submissionsOpen: true });
if (liveSet.editing_allowed) await saveEventSettings({ ...settings, submissionsOpen: true, editingAllowed: false });
const eIns = await j.from('evaluations').insert({
  id: 'J_G_NEG_team-02', judge_id: 'J_G_NEG', judge_uid: jUid, team_id: 'team-02',
  criteria: { c1: 3, c2: 3, c3: 3, c4: 3, c5: 3 }, total: 15, score_version: 2, comment: '',
});
ok('G16a judge can insert own evaluation while submissions open (migration 8)', !eIns.error, eIns.error?.message);
const eUpd = await j.from('evaluations').update({ comment: 'judge edit' }).eq('id', 'J_G_NEG_team-02').select();
ok('G16b judge update own evaluation denied while editing closed', (eUpd.data ?? []).length === 0, eUpd.error?.message);
const eUpdChk = (await supabase.from('evaluations').select('comment').eq('id', 'J_G_NEG_team-02').maybeSingle()).data?.comment;
ok('G16b2 evaluation comment unchanged after judge update attempt', eUpdChk === '', eUpdChk);
const eIns3 = await j.from('evaluations').insert({
  id: 'J_G_NEG_team-03', judge_id: 'J_G_NEG', judge_uid: crypto.randomUUID(), team_id: 'team-03',
  criteria: { c1: 1, c2: 1, c3: 1, c4: 1, c5: 1 }, total: 5, score_version: 2, comment: '',
});
ok('G16c judge cannot insert evaluation under another uid', !!eIns3.error, eIns3.error?.message);
const eIns3Chk = (await supabase.from('evaluations').select('id').eq('id', 'J_G_NEG_team-03').maybeSingle()).data;
ok('G16c2 no evaluation row created under another uid', !eIns3Chk);
if (!liveSet.submissions_open || liveSet.editing_allowed) await saveEventSettings({ ...settings });

const n7 = await j.from('admin_requests').update({ status: 'approved' }).eq('uid', reqUid).select();
ok('G17 judge admin_requests update denied (0 rows)', (n7.data ?? []).length === 0 && !n7.error, n7.error?.message);
const n7b = (await supabase.from('admin_requests').select('status').eq('uid', reqUid).single()).data?.status;
ok('G17b request still rejected after judge attempt', n7b === 'rejected', n7b);

const n8 = await j.from('event_archives').insert({ id: 'ev_hack', event_name: 'x', archived_by: 'judge', total_judges: 0, total_teams: 0, total_submissions: 0, entries: [], score_max: 25 });
ok('G18 judge event_archives insert denied', !!n8.error, n8.error?.message);

const n9 = await j.from('public_summary').update({ total_judges: 99 }).eq('id', true).select();
ok('G19 judge summary update denied (0 rows)', (n9.data ?? []).length === 0 && !n9.error, n9.error?.message);
const n9b = (await supabase.from('public_summary').select('total_judges').single()).data?.total_judges;
ok('G19b summary still 0 after judge attempt', n9b === 0, n9b);

// ---- negatives: fully unauthenticated client ----
const u = createClient(URL, ANON);
const u1 = await u.from('settings_event').update({ tagline: 'HACKED' }).eq('id', true).select();
ok('G20 anon settings update denied', (u1.data ?? []).length === 0, u1.error?.message);
const u2 = await u.from('teams').insert({ id: 'team_hack2', name: 'Hack', project_title: 'x', description: '', logo_url: '', presentation_status: 'Waiting', order_index: 99, tie_breaker_rank: 99 });
ok('G21 anon teams insert denied', !!u2.error, u2.error?.message);
const u3 = await u.from('judges').delete().eq('id', 'J_G_NEG').select();
ok('G22 anon judges delete denied', (u3.data ?? []).length === 0, u3.error?.message);
const u4 = await u.from('event_archives').insert({ id: 'ev_hack2', event_name: 'x', archived_by: 'anon', total_judges: 0, total_teams: 0, total_submissions: 0, entries: [], score_max: 25 });
ok('G23 anon event_archives insert denied', !!u4.error, u4.error?.message);
const u5 = await u.from('public_summary').update({ total_judges: 42 }).eq('id', true).select();
ok('G24 anon summary update denied', (u5.data ?? []).length === 0, u5.error?.message);
const u6 = await u.from('evaluations').insert({
  id: 'J_G_NEG_team-05', judge_id: 'J_G_NEG', judge_uid: crypto.randomUUID(), team_id: 'team-05',
  criteria: { c1: 1, c2: 1, c3: 1, c4: 1, c5: 1 }, total: 5, score_version: 2, comment: '',
});
ok('G24c anon evaluations insert denied', !!u6.error, u6.error?.message);
const u7 = await u.from('evaluations').update({ comment: 'anon edit' }).eq('id', 'J_G_NEG_team-02').select();
ok('G24d anon evaluations update denied', (u7.data ?? []).length === 0 || !!u7.error, u7.error?.message);

// tidy: remove the neg judge row via the app path as admin
await deleteJudgeAndEvaluations('J_G_NEG');
const tidy = (await supabase.from('judges').select('id').eq('id', 'J_G_NEG').maybeSingle()).data;
ok('G25 admin cleanup deletes neg judge', !tidy);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
