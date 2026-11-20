import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJudgePortalUrl,
  calculateDashboardMetrics,
  calculateLeaderboard,
  computeTimerSnapshot,
  formatCountdown,
  generateNextJudgeCode,
  getTeamStatusForJudge,
  isValidStarRating,
} from './scoring';
import type { Evaluation, Judge, Team } from '../types/arena';

const makeTeam = (
  id: string,
  name: string,
  orderIndex: number,
  tieBreakerRank = 0,
  presentationStatus: Team['presentationStatus'] = 'Completed',
): Team => ({
  id,
  name,
  projectTitle: `${name} Project`,
  description: '',
  logoUrl: '',
  presentationStatus,
  orderIndex,
  tieBreakerRank,
  submittedCount: 0,
});

const makeEval = (
  judgeId: string,
  teamId: string,
  rating: number,
): Evaluation => ({
  id: `${judgeId}_${teamId}`,
  judgeId,
  judgeUid: `uid-${judgeId}`,
  teamId,
  rating,
  comment: '',
});

const makeJudge = (id: string, active = true): Judge => ({
  id,
  judgeCode: id,
  name: `Judge ${id}`,
  department: 'CSE',
  email: '',
  uid: '',
  active,
});

test('isValidStarRating accepts integers 1 to 5 and rejects invalid values', () => {
  for (const r of [1, 2, 3, 4, 5]) {
    assert.equal(isValidStarRating(r), true);
  }
  for (const bad of [0, -1, 6, 4.5, NaN, null, undefined, '5']) {
    assert.equal(isValidStarRating(bad), false);
  }
});

test('calculateLeaderboard computes exact average from submitted ratings only (23 / 5 = 4.6)', () => {
  const teams = [makeTeam('team-alpha', 'Team Alpha', 1)];
  const evals = [
    makeEval('JUDGE01', 'team-alpha', 5),
    makeEval('JUDGE02', 'team-alpha', 4),
    makeEval('JUDGE03', 'team-alpha', 5),
    makeEval('JUDGE04', 'team-alpha', 4),
    makeEval('JUDGE05', 'team-alpha', 5),
  ];

  const board = calculateLeaderboard(teams, evals, 15, 'tie');
  assert.equal(board.length, 1);
  assert.equal(board[0].ratingSum, 23);
  assert.equal(board[0].submittedCount, 5);
  assert.equal(board[0].totalJudges, 15);
  assert.equal(board[0].averageFormatted, '4.6');
  assert.equal(board[0].rank, 1);
});

test('calculateLeaderboard ignores pending submissions (12/15 submitted never counted as zero)', () => {
  const teams = [
    makeTeam('team-alpha', 'Team Alpha', 1),
    makeTeam('team-beta', 'Team Beta', 2),
  ];
  const evals: Evaluation[] = [];
  for (let i = 1; i <= 12; i += 1) {
    evals.push(makeEval(`JUDGE${String(i).padStart(2, '0')}`, 'team-alpha', 4));
  }
  for (let i = 1; i <= 15; i += 1) {
    evals.push(makeEval(`JUDGE${String(i).padStart(2, '0')}`, 'team-beta', 3));
  }

  const board = calculateLeaderboard(teams, evals, 15, 'tie');
  assert.equal(board[0].teamId, 'team-alpha');
  assert.equal(board[0].averageFormatted, '4.0');
  assert.equal(board[0].submittedCount, 12);
  assert.equal(board[1].teamId, 'team-beta');
  assert.equal(board[1].averageFormatted, '3.0');
  assert.equal(board[1].submittedCount, 15);
});

test('calculateLeaderboard handles ties and admin tie-breaker modes accurately', () => {
  const teams = [
    makeTeam('team-a', 'Team Alpha', 1, 2),
    makeTeam('team-b', 'Team Beta', 2, 1),
    makeTeam('team-c', 'Team Gamma', 3, 3),
    makeTeam('team-d', 'Team Delta', 4, 4),
  ];
  const evals = [
    makeEval('JUDGE01', 'team-a', 4),
    makeEval('JUDGE01', 'team-b', 4),
    makeEval('JUDGE01', 'team-c', 3),
  ];

  const tiedBoard = calculateLeaderboard(teams, evals, 15, 'tie');
  assert.equal(tiedBoard[0].rank, 1);
  assert.equal(tiedBoard[0].isTied, true);
  assert.equal(tiedBoard[1].rank, 1);
  assert.equal(tiedBoard[1].isTied, true);
  assert.equal(tiedBoard[2].rank, 3);
  assert.equal(tiedBoard[2].isTied, false);
  assert.equal(tiedBoard[3].teamId, 'team-d');
  assert.equal(tiedBoard[3].submittedCount, 0);

  const brokenBoard = calculateLeaderboard(teams, evals, 15, 'admin_order');
  assert.equal(brokenBoard[0].teamId, 'team-b');
  assert.equal(brokenBoard[0].rank, 1);
  assert.equal(brokenBoard[0].isTied, false);
  assert.equal(brokenBoard[1].teamId, 'team-a');
  assert.equal(brokenBoard[1].rank, 2);
});

test('calculateDashboardMetrics computes dynamic judges, teams, submitted, pending, and %', () => {
  const teams = [makeTeam('t1', 'A', 1), makeTeam('t2', 'B', 2)];
  const judges = [makeJudge('J1'), makeJudge('J2'), makeJudge('J3'), makeJudge('J4', false)];
  const evals = [
    makeEval('J1', 't1', 5),
    makeEval('J2', 't1', 4),
    makeEval('J1', 't2', 3),
  ];

  const metrics = calculateDashboardMetrics(teams, judges, evals);
  assert.equal(metrics.totalJudges, 3);
  assert.equal(metrics.totalTeams, 2);
  assert.equal(metrics.totalPossible, 6);
  assert.equal(metrics.totalSubmitted, 3);
  assert.equal(metrics.totalPending, 3);
  assert.equal(metrics.completionPercent, 50);
});

test('computeTimerSnapshot stays synchronized across reloads and detects warnings/expiry', () => {
  const runningState = {
    timerDurationSeconds: 300,
    timerWarningSeconds: 60,
    timerRemainingSeconds: 180,
    timerRunning: true,
    timerStartedAtMs: 1_000_000,
  };

  const mid = computeTimerSnapshot(runningState, 1_060_000);
  assert.equal(mid.remainingSeconds, 120);
  assert.equal(mid.isRunning, true);
  assert.equal(mid.isWarning, false);
  assert.equal(mid.isExpired, false);
  assert.equal(formatCountdown(mid.remainingSeconds), '02:00');

  const warn = computeTimerSnapshot(runningState, 1_130_000);
  assert.equal(warn.remainingSeconds, 50);
  assert.equal(warn.isWarning, true);
  assert.equal(warn.isExpired, false);

  const expired = computeTimerSnapshot(runningState, 1_200_000);
  assert.equal(expired.remainingSeconds, 0);
  assert.equal(expired.isRunning, false);
  assert.equal(expired.isExpired, true);
});

test('getTeamStatusForJudge, generateNextJudgeCode, and buildJudgePortalUrl', () => {
  assert.equal(
    getTeamStatusForJudge(makeTeam('t1', 'A', 1, 0, 'Waiting'), false),
    'Not Evaluated',
  );
  assert.equal(
    getTeamStatusForJudge(makeTeam('t1', 'A', 1, 0, 'Presenting'), false),
    'Evaluation Pending',
  );
  assert.equal(
    getTeamStatusForJudge(makeTeam('t1', 'A', 1, 0, 'Waiting'), true),
    'Submitted',
  );

  assert.equal(
    generateNextJudgeCode([makeJudge('JUDGE01'), makeJudge('JUDGE15')]),
    'JUDGE16',
  );

  assert.equal(
    buildJudgePortalUrl('arena.college.edu/', 'http://localhost:3000'),
    'https://arena.college.edu/judge/login',
  );
  assert.equal(
    buildJudgePortalUrl('', 'https://arena.example.com'),
    'https://arena.example.com/judge/login',
  );
});

test('validateAdminRegistrationInput allows unlimited admins and checks password match', async () => {
  const { INITIAL_15_TEAMS, generateVerificationCode, validateAdminRegistrationInput } = await import(
    './scoring'
  );

  // Initial 15 teams check
  assert.equal(INITIAL_15_TEAMS.length, 15);
  assert.equal(INITIAL_15_TEAMS[0].id, 'team-01');
  assert.equal(INITIAL_15_TEAMS[14].id, 'team-15');

  // Verification code check
  const code = generateVerificationCode();
  assert.match(code, /^[0-9]{6}$/);

  assert.equal(
    validateAdminRegistrationInput({
      name: 'Prof. Anupama',
      email: 'admin1@college.edu',
      password: 'Password123',
      confirmPassword: 'Password123',
      currentAdminCount: 0,
    }),
    null,
  );

  assert.equal(
    validateAdminRegistrationInput({
      name: 'Prof. Rahul',
      email: 'admin2@college.edu',
      password: 'Password123',
      confirmPassword: 'Password123',
      currentAdminCount: 1,
    }),
    null,
  );

  // Unlimited admins allowed: 3rd, 4th, etc. not blocked by registration validator
  assert.equal(
    validateAdminRegistrationInput({
      name: 'Third Admin User',
      email: 'admin3@college.edu',
      password: 'Password123',
      confirmPassword: 'Password123',
      currentAdminCount: 2,
    }),
    null,
  );

  const mismatchErr = validateAdminRegistrationInput({
    name: 'Prof. Anupama',
    email: 'admin1@college.edu',
    password: 'Password123',
    confirmPassword: 'Password999',
    currentAdminCount: 0,
  });
  assert.ok(mismatchErr && mismatchErr.includes('do not match'));
});

test('custom admin timer helpers clamp durations and split minutes and seconds', async () => {
  const {
    clampTimerDurationSeconds,
    clampTimerWarningSeconds,
    splitSecondsToMinutesAndSeconds,
  } = await import('./scoring');

  assert.equal(clampTimerDurationSeconds(0, 5), 10);
  assert.equal(clampTimerDurationSeconds(2, 30), 150);
  assert.equal(clampTimerDurationSeconds(150, 0), 7200);

  assert.equal(clampTimerWarningSeconds(1, 30, 150), 90);
  assert.equal(clampTimerWarningSeconds(5, 0, 150), 150);

  assert.deepEqual(splitSecondsToMinutesAndSeconds(150), {
    minutes: 2,
    seconds: 30,
  });
});

test('whole-event timer H:M:S helpers and judge Name+Email validation', async () => {
  const {
    clampWholeEventTimerSeconds,
    splitSecondsToHms,
    formatHmsCountdown,
    validateJudgeNameAndEmail,
    generateJudgeIdFromUid,
  } = await import('./scoring');

  assert.equal(clampWholeEventTimerSeconds(0, 0, 0), 0);
  assert.equal(clampWholeEventTimerSeconds(2, 30, 15), 9015);
  assert.equal(clampWholeEventTimerSeconds(30, 0, 0), 86400);
  assert.deepEqual(splitSecondsToHms(9015), {
    hours: 2,
    minutes: 30,
    seconds: 15,
  });
  assert.equal(formatHmsCountdown(9015), '02:30:15');

  assert.equal(validateJudgeNameAndEmail('A', 'judge@college.edu') !== null, true);
  assert.equal(validateJudgeNameAndEmail('Dr. Mehta', 'invalid-email') !== null, true);
  assert.equal(validateJudgeNameAndEmail('Dr. Mehta', 'mehta@college.edu'), null);
  assert.match(generateJudgeIdFromUid('abc123XYZ'), /^J_ABC123XYZ$/);
});


