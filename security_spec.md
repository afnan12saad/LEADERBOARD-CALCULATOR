# RANK RUSH Firestore Security Specification

## 1. Data Invariants

1. **Single Overall Rating Per Judge Per Team**: Each evaluation document has deterministic ID `${judgeId}_${teamId}`, preventing duplicate ratings at the database key level.
2. **Rating Bounds**: Every evaluation rating must be an integer between `1` and `5` inclusive. Optional feedback comments are capped at `1000` characters.
3. **Judge Isolation & Privacy**: Judges authenticate seamlessly with Name + Email via Firebase Anonymous Auth (`request.auth != null`) and can only read and write evaluations where `judgeUid == request.auth.uid` and `judgeId` matches their `judgeSessions/{uid}` binding. Judges cannot read other judges' ratings or comments.
4. **Confidentiality of Judge & Admin Records**: Admin credentials and `judgeCredentials/{judgeId}` (legacy) are accessible exclusively by verified email/password admins. Judges manage only their own `judges/{judgeId}` and `judgeSessions/{uid}` records.
5. **Publication Gate**: `publicResults/leaderboard` can only be read by non-admins when `settings/event.resultsPublished == true`. Before release, only administrators can view standings and leaderboard rankings.
6. **Atomic Submission Accounting**: When a judge creates a new evaluation, `evaluations/{evalId}` and `teams/{teamId}.submittedCount` increment (`+1`) are validated atomically via `existsAfter` / `getAfter` in the same batch.
7. **Submission & Edit Controls**: Judge evaluation creation requires `settings/event.submissionsOpen == true`. Judge evaluation updates require `settings/event.submissionsOpen == true` and `settings/event.editingAllowed == true`.
8. **Temporal & Identity Integrity**: `createdAt` and `updatedAt` are strictly validated against `request.time`, and `judgeUid` / `uid` fields must equal `request.auth.uid`.
9. **Unlimited Admins with First-Admin Verification & Approval**: First admin registers without limit; any subsequent admin registration creates an `adminRequests/{uid}` record with a 6-digit verification code sent to the first admin's email and requires explicit first-admin approval or verification code match before the user can claim an administrator slot.
10. **Admin-Exclusive Team Management**: ONLY authenticated administrators (`isAdmin()`) can create, update metadata, or delete teams in `/teams/{teamId}`. Judges and students are strictly blocked from adding teams.
11. **Whole-Event Timer Bounds**: `timerDurationSeconds` and `timerRemainingSeconds` are bounded to `0..86400` seconds (up to 24 hours), starting at `0`.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)

1. **Out-of-Range Rating (0)**: `{ id: "JUDGE01_team-01", judgeId: "JUDGE01", judgeUid: "<uid>", teamId: "team-01", rating: 0, comment: "" }`
2. **Out-of-Range Rating (6)**: `{ id: "JUDGE01_team-01", judgeId: "JUDGE01", judgeUid: "<uid>", teamId: "team-01", rating: 6, comment: "" }`
3. **Float Rating Poisoning**: `{ id: "JUDGE01_team-01", judgeId: "JUDGE01", judgeUid: "<uid>", teamId: "team-01", rating: 4.5, comment: "" }`
4. **Shadow Field Injection**: Evaluation payload containing extra key `isBonus: true` or `weight: 100`.
5. **Judge Impersonation**: Judge `uidA` attempting to create `evaluations/JUDGE02_team-01` with `judgeId: "JUDGE02"`.
6. **Cross-Judge Read Snooping**: Judge `uidA` calling `list` or `get` on `evaluations` without filtering `judgeUid == uidA` or reading `evaluations/JUDGE02_team-01`.
7. **Pre-Publication Score Leak**: Anonymous or judge user reading `publicResults/leaderboard` while `settings/event.resultsPublished == false`.
8. **Unauthorized Team Creation by Non-Admin**: Judge or unauthenticated user attempting to create a team in `/teams/{teamId}`.
9. **Unapproved Admin Creation Bypass**: New user attempting to create `/admins/{uid}` when other admins already exist without an approved `adminRequests/{uid}` record.
10. **Unauthorized Team Count Tampering**: Judge incrementing `teams/team-01.submittedCount` without atomically creating their own new evaluation in the same batch.
11. **Closed Submissions Bypass**: Judge attempting to submit an evaluation while `settings/event.submissionsOpen == false`.
12. **Tampered Verification Code Bypass**: New admin attempting to approve their own `adminRequests/{uid}` with a non-matching verification code.
