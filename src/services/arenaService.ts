import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import {
  BOOTSTRAPPED_ADMIN_EMAILS,
  OperationType,
  db,
  handleFirestoreError,
} from '../firebase';
import type {
  AdminQuota,
  AdminRequest,
  AdminUser,
  Evaluation,
  EventSettings,
  Judge,
  JudgeCredential,
  JudgeSession,
  PresentationStatus,
  PublicSummary,
  PublishedLeaderboard,
  Team,
} from '../types/arena';
import {
  INITIAL_15_TEAMS,
  MAX_ADMIN_USERS,
  MAX_WHOLE_EVENT_TIMER_SECONDS,
  calculateLeaderboard,
  generateJudgeIdFromUid,
  generateVerificationCode,
  isValidStarRating,
  slugifyTeamId,
  validateJudgeNameAndEmail,
} from '../utils/scoring';

export const DEFAULT_EVENT_SETTINGS: Omit<EventSettings, 'updatedAt'> = {
  eventName: 'Annual Engineering Project Showcase',
  collegeName: 'Department of Computer Science & Engineering',
  tagline: 'Innovate. Present. Inspire.',
  venue: 'Main Auditorium, Academic Block A',
  eventDate: 'November 20, 2026',
  customDomain: '',
  submissionsOpen: true,
  editingAllowed: false,
  resultsPublished: false,
  tieBreakerMode: 'tie',
  currentTeamId: '',
  timerDurationSeconds: 0,
  timerWarningSeconds: 0,
  timerRemainingSeconds: 0,
  timerRunning: false,
  timerStartedAtMs: 0,
};

export function subscribeEventSettings(
  onData: (settings: EventSettings | null) => void,
): Unsubscribe {
  const path = 'settings/event';
  return onSnapshot(
    doc(db, 'settings', 'event'),
    (snap) => {
      onData(snap.exists() ? (snap.data() as EventSettings) : null);
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    },
  );
}

export function subscribePublicSummary(
  onData: (summary: PublicSummary | null) => void,
): Unsubscribe {
  const path = 'publicStats/summary';
  return onSnapshot(
    doc(db, 'publicStats', 'summary'),
    (snap) => {
      onData(snap.exists() ? (snap.data() as PublicSummary) : null);
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    },
  );
}

export function subscribeAdminQuota(
  onData: (quota: AdminQuota) => void,
): Unsubscribe {
  const path = 'publicStats/adminQuota';
  return onSnapshot(
    doc(db, 'publicStats', 'adminQuota'),
    (snap) => {
      if (snap.exists()) {
        onData(snap.data() as AdminQuota);
      } else {
        onData({ count: 0, maxAdmins: MAX_ADMIN_USERS });
      }
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    },
  );
}

export function subscribeAllAdmins(
  onData: (admins: AdminUser[]) => void,
): Unsubscribe {
  const path = 'admins';
  return onSnapshot(
    collection(db, 'admins'),
    (snap) => {
      const list = snap.docs.map((d) => d.data() as AdminUser);
      list.sort((a, b) => a.email.localeCompare(b.email));
      onData(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    },
  );
}

export function subscribeAdminRequests(
  onData: (requests: AdminRequest[]) => void,
): Unsubscribe {
  const path = 'adminRequests';
  const q = query(
    collection(db, 'adminRequests'),
    orderBy('requestedAt', 'desc'),
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map((d) => d.data() as AdminRequest);
      onData(list);
    },
    (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('permission') ||
        msg.includes('Missing or insufficient')
      ) {
        onData([]);
        return;
      }
      handleFirestoreError(error, OperationType.LIST, path);
    },
  );
}

export function subscribeMyPendingAdminRequest(
  uid: string,
  onData: (request: AdminRequest | null) => void,
): Unsubscribe {
  const path = `adminRequests/${uid}`;
  return onSnapshot(
    doc(db, 'adminRequests', uid),
    (snap) => {
      onData(snap.exists() ? (snap.data() as AdminRequest) : null);
    },
    (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('permission') ||
        msg.includes('Missing or insufficient')
      ) {
        onData(null);
        return;
      }
      handleFirestoreError(error, OperationType.GET, path);
    },
  );
}

export async function getLiveAdminQuotaCount(): Promise<number> {
  try {
    const snap = await getDoc(doc(db, 'publicStats', 'adminQuota'));
    if (!snap.exists()) return 0;
    const data = snap.data() as AdminQuota;
    return typeof data.count === 'number' ? data.count : 0;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, 'publicStats/adminQuota');
  }
}

export async function getFirstAdminInfo(): Promise<{
  email: string;
  uid: string;
  name: string;
}> {
  try {
    const qSnap = await getDoc(doc(db, 'publicStats', 'adminQuota'));
    if (qSnap.exists()) {
      const qData = qSnap.data() as AdminQuota;
      if (qData.firstAdminEmail) {
        return {
          email: qData.firstAdminEmail,
          uid: qData.firstAdminUid || '',
          name: 'Primary Administrator',
        };
      }
    }
    const adminsSnap = await getDocs(
      query(collection(db, 'admins'), orderBy('createdAt', 'asc')),
    );
    if (!adminsSnap.empty) {
      const first = adminsSnap.docs[0].data() as AdminUser;
      return {
        email: first.email,
        uid: first.uid,
        name: first.name || 'Primary Administrator',
      };
    }
  } catch {
    // ignore
  }
  return {
    email: BOOTSTRAPPED_ADMIN_EMAILS[0],
    uid: '',
    name: 'Primary Administrator',
  };
}

export async function createAdminJoinRequest(params: {
  user: User;
  name: string;
}): Promise<AdminRequest> {
  const cleanEmail = (params.user.email ?? '').trim().slice(0, 160);
  const cleanName = params.name.trim().slice(0, 100) || 'Co-Administrator';
  const firstAdmin = await getFirstAdminInfo();
  const code = generateVerificationCode();

  const reqDoc: AdminRequest = {
    id: params.user.uid,
    uid: params.user.uid,
    email: cleanEmail,
    name: cleanName,
    verificationCode: code,
    status: 'pending',
    firstAdminEmail: firstAdmin.email,
    firstAdminUid: firstAdmin.uid,
  };

  try {
    await setDoc(doc(db, 'adminRequests', params.user.uid), {
      ...reqDoc,
      requestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return reqDoc;
  } catch (err) {
    handleFirestoreError(
      err,
      OperationType.CREATE,
      `adminRequests/${params.user.uid}`,
    );
  }
}

export async function approveAdminJoinRequest(
  request: AdminRequest,
  approvedByEmail: string,
): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, 'adminRequests', request.uid), {
    status: 'approved',
    approvedAt: serverTimestamp(),
    approvedBy: approvedByEmail.trim().slice(0, 160),
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'admins', request.uid), {
    uid: request.uid,
    email: request.email,
    name: request.name,
    isFirstAdmin: false,
    createdAt: serverTimestamp(),
  });
  batch.set(
    doc(db, 'publicStats', 'adminQuota'),
    {
      count: increment(1),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `admins/${request.uid}`);
  }
}

export async function rejectAdminJoinRequest(requestUid: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'adminRequests', requestUid), {
      status: 'rejected',
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(
      err,
      OperationType.UPDATE,
      `adminRequests/${requestUid}`,
    );
  }
}

export async function claimAdminSlot(
  user: User,
  preferredName?: string,
): Promise<AdminUser> {
  if (!user.emailVerified) {
    throw new Error(
      'Please verify your email address via the verification link before accessing the Admin Console.',
    );
  }

  const existingSnap = await getDoc(doc(db, 'admins', user.uid));
  if (existingSnap.exists()) {
    return existingSnap.data() as AdminUser;
  }

  const currentCount = await getLiveAdminQuotaCount();
  const cleanEmail = (user.email ?? '').trim().slice(0, 160);
  const fallbackName = cleanEmail.split('@')[0] || 'Event Admin';
  const cleanName = (preferredName || user.displayName || fallbackName)
    .trim()
    .slice(0, 100);

  const isBootstrap =
    BOOTSTRAPPED_ADMIN_EMAILS.includes(cleanEmail.toLowerCase()) ||
    currentCount === 0;

  if (isBootstrap) {
    // First / Primary Admin bootstrap:
    const batch = writeBatch(db);
    batch.set(doc(db, 'admins', user.uid), {
      uid: user.uid,
      email: cleanEmail,
      name: cleanName,
      isFirstAdmin: true,
      createdAt: serverTimestamp(),
    });
    batch.set(
      doc(db, 'publicStats', 'adminQuota'),
      {
        count: currentCount + 1,
        firstAdminEmail: cleanEmail,
        firstAdminUid: user.uid,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    try {
      await batch.commit();
      return {
        uid: user.uid,
        email: cleanEmail,
        name: cleanName,
        isFirstAdmin: true,
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `admins/${user.uid}`);
    }
  }

  // Not the first admin: must have approved adminRequest
  const reqSnap = await getDoc(doc(db, 'adminRequests', user.uid));
  if (!reqSnap.exists() || (reqSnap.data() as AdminRequest).status !== 'approved') {
    throw new Error(
      'Administrator approval required. A verification code and approval request has been sent to the primary administrator. Please wait for their approval or enter the verification code.',
    );
  }

  const batch = writeBatch(db);
  batch.set(doc(db, 'admins', user.uid), {
    uid: user.uid,
    email: cleanEmail,
    name: cleanName,
    isFirstAdmin: false,
    createdAt: serverTimestamp(),
  });
  batch.set(
    doc(db, 'publicStats', 'adminQuota'),
    {
      count: increment(1),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `admins/${user.uid}`);
  }

  return {
    uid: user.uid,
    email: cleanEmail,
    name: cleanName,
    isFirstAdmin: false,
  };
}

export async function removeAdminAccount(targetUid: string): Promise<void> {
  try {
    const currentCount = await getLiveAdminQuotaCount();
    const batch = writeBatch(db);
    batch.delete(doc(db, 'admins', targetUid));
    batch.set(
      doc(db, 'publicStats', 'adminQuota'),
      {
        count: Math.max(0, currentCount - 1),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `admins/${targetUid}`);
  }
}

export function subscribeTeams(onData: (teams: Team[]) => void): Unsubscribe {
  const path = 'teams';
  const q = query(collection(db, 'teams'), orderBy('orderIndex', 'asc'));
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map((d) => d.data() as Team);
      onData(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    },
  );
}

export function subscribePublishedLeaderboard(
  onData: (board: PublishedLeaderboard | null) => void,
  canRead: boolean,
): Unsubscribe {
  if (!canRead) {
    onData(null);
    return () => {};
  }
  const path = 'publicResults/leaderboard';
  return onSnapshot(
    doc(db, 'publicResults', 'leaderboard'),
    (snap) => {
      onData(snap.exists() ? (snap.data() as PublishedLeaderboard) : null);
    },
    (error) => {
      // If results were just unpublished mid-session, gracefully hide rather than crashing
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('permission') || msg.includes('Missing or insufficient')) {
        onData(null);
        return;
      }
      handleFirestoreError(error, OperationType.GET, path);
    },
  );
}

export function subscribeMyEvaluations(
  judgeUid: string,
  onData: (evaluations: Evaluation[]) => void,
): Unsubscribe {
  const path = 'evaluations';
  const q = query(
    collection(db, 'evaluations'),
    where('judgeUid', '==', judgeUid),
  );
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as Evaluation));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    },
  );
}

export function subscribeAllJudges(
  onData: (judges: Judge[]) => void,
): Unsubscribe {
  const path = 'judges';
  const q = query(collection(db, 'judges'), orderBy('judgeCode', 'asc'));
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as Judge));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    },
  );
}

export function subscribeAllJudgeCredentials(
  onData: (creds: JudgeCredential[]) => void,
): Unsubscribe {
  const path = 'judgeCredentials';
  return onSnapshot(
    collection(db, 'judgeCredentials'),
    (snap) => {
      onData(snap.docs.map((d) => d.data() as JudgeCredential));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    },
  );
}

export function subscribeAllEvaluations(
  onData: (evaluations: Evaluation[]) => void,
): Unsubscribe {
  const path = 'evaluations';
  return onSnapshot(
    collection(db, 'evaluations'),
    (snap) => {
      onData(snap.docs.map((d) => d.data() as Evaluation));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    },
  );
}

export async function registerJudgeByNameEmail(
  user: User,
  rawName: string,
  rawEmail: string,
): Promise<Judge> {
  const errMsg = validateJudgeNameAndEmail(rawName, rawEmail);
  if (errMsg) {
    throw new Error(errMsg);
  }

  const cleanName = rawName.trim().slice(0, 100);
  const cleanEmail = rawEmail.trim().toLowerCase().slice(0, 160);

  const sessionSnap = await getDoc(doc(db, 'judgeSessions', user.uid));
  if (sessionSnap.exists()) {
    const existingSession = sessionSnap.data() as JudgeSession;
    const judgeSnap = await getDoc(doc(db, 'judges', existingSession.judgeId));
    if (judgeSnap.exists()) {
      const existingJudge = judgeSnap.data() as Judge;
      if (!existingJudge.active) {
        throw new Error(
          'Your judge access has been deactivated by an administrator.',
        );
      }
      await updateDoc(doc(db, 'judges', existingJudge.id), {
        name: cleanName,
        email: cleanEmail,
        updatedAt: serverTimestamp(),
      });
      return {
        ...existingJudge,
        name: cleanName,
        email: cleanEmail,
      };
    }
  }

  const judgeId = generateJudgeIdFromUid(user.uid);
  const batch = writeBatch(db);
  batch.set(doc(db, 'judges', judgeId), {
    id: judgeId,
    judgeCode: judgeId,
    name: cleanName,
    department: '',
    email: cleanEmail,
    uid: user.uid,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'judgeSessions', user.uid), {
    uid: user.uid,
    judgeId,
    accessCode: 'SELF_AUTH',
    createdAt: serverTimestamp(),
  });
  // Server-side increment with merge: no stale read, so simultaneous sign-ups
  // all satisfy the rule `totalJudges == existing + 1` (first write creates 1).
  // `merge: true` is required: a plain set() with increment() is rejected by
  // the rules (verified in the Firestore emulator).
  batch.set(
    doc(db, 'publicStats', 'summary'),
    {
      totalJudges: increment(1),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `judges/${judgeId}`);
  }

  return {
    id: judgeId,
    judgeCode: judgeId,
    name: cleanName,
    department: '',
    email: cleanEmail,
    uid: user.uid,
    active: true,
  };
}

export async function claimJudgeSlot(
  user: User,
  rawJudgeCode: string,
  rawAccessCode: string,
): Promise<Judge> {
  const judgeId = rawJudgeCode.trim().toUpperCase();
  const accessCode = rawAccessCode.trim();

  if (!judgeId || !/^[A-Z0-9_-]{2,32}$/.test(judgeId)) {
    throw new Error('Enter a valid Judge ID (for example: JUDGE01).');
  }
  if (!accessCode || accessCode.length < 4) {
    throw new Error('Enter your assigned access code (minimum 4 characters).');
  }

  const batch = writeBatch(db);
  batch.set(doc(db, 'judgeSessions', user.uid), {
    uid: user.uid,
    judgeId,
    accessCode,
    createdAt: serverTimestamp(),
  });
  batch.update(doc(db, 'judges', judgeId), {
    uid: user.uid,
    email: (user.email ?? '').slice(0, 160),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('permission') || msg.includes('Missing or insufficient')) {
      throw new Error(
        'Invalid Judge ID or access code, or this Judge ID is already assigned to a different account.',
      );
    }
    throw err;
  }

  try {
    const judgeSnap = await getDoc(doc(db, 'judges', judgeId));
    if (!judgeSnap.exists()) {
      throw new Error('Judge profile could not be loaded after verification.');
    }
    return judgeSnap.data() as Judge;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `judges/${judgeId}`);
  }
}

export async function submitOverallRating(params: {
  judgeId: string;
  judgeUid: string;
  teamId: string;
  rating: number;
  comment: string;
  isEdit: boolean;
}): Promise<void> {
  const { judgeId, judgeUid, teamId, rating, comment, isEdit } = params;
  if (!isValidStarRating(rating)) {
    throw new Error('Select an overall rating between 1 and 5 stars.');
  }

  const cleanComment = comment.trim().slice(0, 1000);
  const evalId = `${judgeId}_${teamId}`;
  const evalPath = `evaluations/${evalId}`;

  if (isEdit) {
    try {
      await updateDoc(doc(db, 'evaluations', evalId), {
        rating,
        comment: cleanComment,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, evalPath);
    }
    return;
  }

  const batch = writeBatch(db);
  batch.set(doc(db, 'evaluations', evalId), {
    id: evalId,
    judgeId,
    judgeUid,
    teamId,
    rating,
    comment: cleanComment,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'teams', teamId), {
    submittedCount: increment(1),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, evalPath);
  }
}

export async function initializeDefaultEventData(): Promise<void> {
  const batch = writeBatch(db);

  batch.set(doc(db, 'settings', 'event'), {
    ...DEFAULT_EVENT_SETTINGS,
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'publicStats', 'summary'), {
    totalJudges: 0,
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'publicResults', 'leaderboard'), {
    published: false,
    totalJudges: 0,
    totalTeams: 0,
    totalSubmissions: 0,
    entries: [],
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'settings/event');
  }
}

export async function saveEventSettings(
  settings: EventSettings,
): Promise<void> {
  try {
    await setDoc(doc(db, 'settings', 'event'), {
      eventName: settings.eventName.trim().slice(0, 120) || 'Project Arena',
      collegeName:
        settings.collegeName.trim().slice(0, 140) || 'College Project Showcase',
      tagline: settings.tagline.trim().slice(0, 120),
      venue: settings.venue.trim().slice(0, 140),
      eventDate: settings.eventDate.trim().slice(0, 60),
      customDomain: settings.customDomain.trim().slice(0, 200),
      submissionsOpen: Boolean(settings.submissionsOpen),
      editingAllowed: Boolean(settings.editingAllowed),
      resultsPublished: Boolean(settings.resultsPublished),
      // Always 'tie': normalizes any legacy 'admin_order' value on save.
      tieBreakerMode: 'tie',
      currentTeamId: settings.currentTeamId.slice(0, 128),
      timerDurationSeconds: Math.min(
        MAX_WHOLE_EVENT_TIMER_SECONDS,
        Math.max(0, Math.round(settings.timerDurationSeconds)),
      ),
      timerWarningSeconds: Math.min(
        43200,
        Math.max(0, Math.round(settings.timerWarningSeconds)),
      ),
      timerRemainingSeconds: Math.min(
        MAX_WHOLE_EVENT_TIMER_SECONDS,
        Math.max(0, Math.round(settings.timerRemainingSeconds)),
      ),
      timerRunning: Boolean(settings.timerRunning),
      timerStartedAtMs: Math.max(0, Math.round(settings.timerStartedAtMs)),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'settings/event');
  }
}

export async function saveTeamRecord(params: {
  existingTeam?: Team;
  name: string;
  projectTitle: string;
  description: string;
  logoUrl: string;
  presentationStatus: PresentationStatus;
  orderIndex: number;
  tieBreakerRank: number;
}): Promise<void> {
  const cleanName = params.name.trim().slice(0, 100);
  const cleanTitle = params.projectTitle.trim().slice(0, 160);
  const cleanDesc = params.description.trim().slice(0, 500);
  const cleanLogo = params.logoUrl.trim().slice(0, 200000);

  if (!cleanName || !cleanTitle) {
    throw new Error('Team name and project title are required.');
  }

  if (params.existingTeam) {
    const id = params.existingTeam.id;
    try {
      await updateDoc(doc(db, 'teams', id), {
        name: cleanName,
        projectTitle: cleanTitle,
        description: cleanDesc,
        logoUrl: cleanLogo,
        presentationStatus: params.presentationStatus,
        orderIndex: Math.max(0, Math.round(params.orderIndex)),
        tieBreakerRank: Math.max(0, Math.round(params.tieBreakerRank)),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `teams/${id}`);
    }
    return;
  }

  let newId = slugifyTeamId(cleanName);
  const check = await getDoc(doc(db, 'teams', newId));
  if (check.exists()) {
    newId = `${newId}-${Date.now().toString(36)}`;
  }

  try {
    await setDoc(doc(db, 'teams', newId), {
      id: newId,
      name: cleanName,
      projectTitle: cleanTitle,
      description: cleanDesc,
      logoUrl: cleanLogo,
      presentationStatus: params.presentationStatus,
      orderIndex: Math.max(0, Math.round(params.orderIndex)),
      tieBreakerRank: Math.max(0, Math.round(params.tieBreakerRank)),
      submittedCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `teams/${newId}`);
  }
}

export async function deleteTeamAndEvaluations(
  teamId: string,
  currentSettings: EventSettings | null,
): Promise<void> {
  try {
    const evalsSnap = await getDocs(
      query(collection(db, 'evaluations'), where('teamId', '==', teamId)),
    );
    const batch = writeBatch(db);
    for (const d of evalsSnap.docs) {
      batch.delete(d.ref);
    }
    batch.delete(doc(db, 'teams', teamId));
    if (currentSettings && currentSettings.currentTeamId === teamId) {
      batch.update(doc(db, 'settings', 'event'), {
        currentTeamId: '',
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `teams/${teamId}`);
  }
}

export async function saveJudgeRecord(params: {
  existingJudge?: Judge;
  judgeCode: string;
  name: string;
  department: string;
  email: string;
  accessCode: string;
  active: boolean;
  allJudgesCountAfter: number;
}): Promise<void> {
  const code = params.judgeCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const cleanName = params.name.trim().slice(0, 100);
  const cleanDept = params.department.trim().slice(0, 100);
  const cleanEmail = params.email.trim().slice(0, 160);
  const cleanPin = params.accessCode.trim().slice(0, 64);

  if (!code || code.length < 2) {
    throw new Error('Judge ID must be at least 2 characters (e.g. JUDGE16).');
  }
  if (!cleanName) {
    throw new Error('Judge name is required.');
  }
  if (!cleanPin || cleanPin.length < 4) {
    throw new Error('Access code must be at least 4 characters.');
  }

  const batch = writeBatch(db);
  if (params.existingJudge) {
    const id = params.existingJudge.id;
    batch.update(doc(db, 'judges', id), {
      judgeCode: code,
      name: cleanName,
      department: cleanDept,
      email: cleanEmail,
      active: params.active,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'judgeCredentials', id), {
      judgeId: id,
      accessCode: cleanPin,
      updatedAt: serverTimestamp(),
    });
  } else {
    const existing = await getDoc(doc(db, 'judges', code));
    if (existing.exists()) {
      throw new Error(`Judge ID ${code} already exists.`);
    }
    batch.set(doc(db, 'judges', code), {
      id: code,
      judgeCode: code,
      name: cleanName,
      department: cleanDept,
      email: cleanEmail,
      uid: '',
      active: params.active,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'judgeCredentials', code), {
      judgeId: code,
      accessCode: cleanPin,
      updatedAt: serverTimestamp(),
    });
  }

  batch.set(doc(db, 'publicStats', 'summary'), {
    totalJudges: Math.max(0, params.allJudgesCountAfter),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `judges/${code}`);
  }
}

export async function unlinkJudgeAccount(judgeId: string): Promise<void> {
  try {
    const snap = await getDoc(doc(db, 'judges', judgeId));
    if (!snap.exists()) return;
    const judge = snap.data() as Judge;
    const batch = writeBatch(db);
    if (judge.uid) {
      batch.delete(doc(db, 'judgeSessions', judge.uid));
    }
    batch.update(doc(db, 'judges', judgeId), {
      uid: '',
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `judges/${judgeId}`);
  }
}

export async function deleteJudgeAndEvaluations(
  judge: Judge,
  remainingActiveJudgesCount: number,
): Promise<void> {
  try {
    const evalsSnap = await getDocs(
      query(collection(db, 'evaluations'), where('judgeId', '==', judge.id)),
    );
    const teamDecrements = new Map<string, number>();
    for (const d of evalsSnap.docs) {
      const ev = d.data() as Evaluation;
      teamDecrements.set(ev.teamId, (teamDecrements.get(ev.teamId) ?? 0) + 1);
    }

    const batch = writeBatch(db);
    for (const d of evalsSnap.docs) {
      batch.delete(d.ref);
    }
    for (const [teamId, count] of teamDecrements.entries()) {
      batch.update(doc(db, 'teams', teamId), {
        submittedCount: increment(-count),
        updatedAt: serverTimestamp(),
      });
    }
    if (judge.uid) {
      batch.delete(doc(db, 'judgeSessions', judge.uid));
    }
    batch.delete(doc(db, 'judgeCredentials', judge.id));
    batch.delete(doc(db, 'judges', judge.id));
    batch.set(doc(db, 'publicStats', 'summary'), {
      totalJudges: Math.max(0, remainingActiveJudgesCount),
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `judges/${judge.id}`);
  }
}

export async function publishOrHideResults(params: {
  publish: boolean;
  teams: Team[];
  judges: Judge[];
  evaluations: Evaluation[];
  settings: EventSettings;
}): Promise<void> {
  const { publish, teams, judges, evaluations, settings } = params;
  const activeJudges = judges.filter((j) => j.active).length;
  const entries = publish
    ? calculateLeaderboard(
        teams,
        evaluations,
        activeJudges,
        settings.tieBreakerMode,
      )
    : [];

  const batch = writeBatch(db);
  batch.update(doc(db, 'settings', 'event'), {
    resultsPublished: publish,
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'publicResults', 'leaderboard'), {
    published: publish,
    totalJudges: activeJudges,
    totalTeams: teams.length,
    totalSubmissions: evaluations.length,
    entries,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'publicResults/leaderboard');
  }
}

export async function resetEventEvaluations(
  teams: Team[],
  judges: Judge[],
  settings: EventSettings,
): Promise<void> {
  try {
    const evalsSnap = await getDocs(collection(db, 'evaluations'));
    const batch = writeBatch(db);
    for (const d of evalsSnap.docs) {
      batch.delete(d.ref);
    }
    for (const t of teams) {
      batch.update(doc(db, 'teams', t.id), {
        submittedCount: 0,
        presentationStatus: 'Waiting',
        updatedAt: serverTimestamp(),
      });
    }
    batch.set(doc(db, 'settings', 'event'), {
      ...settings,
      resultsPublished: false,
      submissionsOpen: true,
      timerRemainingSeconds: settings.timerDurationSeconds,
      timerRunning: false,
      timerStartedAtMs: 0,
      currentTeamId: '',
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'publicResults', 'leaderboard'), {
      published: false,
      totalJudges: judges.filter((j) => j.active).length,
      totalTeams: teams.length,
      totalSubmissions: 0,
      entries: [],
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'evaluations');
  }
}

export async function initializeEverythingToZeroWith15Teams(
  existingSettings?: EventSettings | null,
  options?: {
    onlyIfNoRatings?: boolean;
    expectedRatingCount?: number;
    clearResetLock?: boolean;
    beforeChunk?: () => Promise<void>;
  },
): Promise<void> {
  try {
    const [evalsSnap, teamsSnap, judgesSnap, sessionsSnap, credsSnap] =
      await Promise.all([
        getDocs(collection(db, 'evaluations')),
        getDocs(collection(db, 'teams')),
        getDocs(collection(db, 'judges')),
        getDocs(collection(db, 'judgeSessions')),
        getDocs(collection(db, 'judgeCredentials')),
      ]);

    // Automatic first-run setup must never wipe an event that already has ratings.
    if (options?.onlyIfNoRatings && !evalsSnap.empty) return;

    // If ratings changed since the archive was taken, stop before deleting anything.
    if (
      options?.expectedRatingCount !== undefined &&
      evalsSnap.size !== options.expectedRatingCount
    ) {
      throw new Error(
        'Ratings changed after the archive was saved. Nothing was reset. Try again.',
      );
    }

    // A full event has thousands of ratings, so delete in modest chunks rather
    // than one huge request (keeps each request small and a failure recoverable). The small final batch
    // (default teams, settings, counters) runs last so a failure part-way
    // never publishes a half-reset state as complete.
    const toDelete = [
      ...evalsSnap.docs,
      ...judgesSnap.docs,
      ...sessionsSnap.docs,
      ...credsSnap.docs,
      ...teamsSnap.docs,
    ].map((d) => d.ref);
    for (let i = 0; i < toDelete.length; i += 400) {
      if (options?.beforeChunk) await options.beforeChunk();
      const chunk = writeBatch(db);
      for (const ref of toDelete.slice(i, i + 400)) chunk.delete(ref);
      await chunk.commit();
    }

    const batch = writeBatch(db);
    for (let i = 0; i < INITIAL_15_TEAMS.length; i += 1) {
      const t = INITIAL_15_TEAMS[i];
      batch.set(doc(db, 'teams', t.id), {
        id: t.id,
        name: t.name,
        projectTitle: t.projectTitle,
        description: t.description,
        logoUrl: '',
        presentationStatus: 'Waiting',
        orderIndex: i + 1,
        tieBreakerRank: i + 1,
        submittedCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const baseSettings = existingSettings || DEFAULT_EVENT_SETTINGS;
    batch.set(doc(db, 'settings', 'event'), {
      ...baseSettings,
      resultsPublished: false,
      submissionsOpen: true,
      editingAllowed: false,
      currentTeamId: '',
      timerDurationSeconds: 0,
      timerWarningSeconds: 0,
      timerRemainingSeconds: 0,
      timerRunning: false,
      timerStartedAtMs: 0,
      tieBreakerMode: 'tie',
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'publicStats', 'summary'), {
      totalJudges: 0,
      updatedAt: serverTimestamp(),
    });

    // Only the last write of a finished reset clears the in-progress marker.
    if (options?.clearResetLock) batch.delete(doc(db, 'eventResets', 'current'));

    batch.set(doc(db, 'publicResults', 'leaderboard'), {
      published: false,
      totalJudges: 0,
      totalTeams: INITIAL_15_TEAMS.length,
      totalSubmissions: 0,
      entries: [],
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'settings/event');
  }
}

/**
 * Save the current event's final standings (no judge emails, no individual
 * ratings) to eventArchives so a reset never loses the results. Returns the
 * archive id after confirming the document can be read back.
 */
export async function archiveCurrentEventResults(
  settings: EventSettings,
  archivedBy: string,
): Promise<string> {
  try {
    const [teamsSnap, evalsSnap, judgesSnap] = await Promise.all([
      getDocs(collection(db, 'teams')),
      getDocs(collection(db, 'evaluations')),
      getDocs(collection(db, 'judges')),
    ]);
    const teams = teamsSnap.docs.map((d) => d.data() as Team);
    const evaluations = evalsSnap.docs.map((d) => d.data() as Evaluation);
    const entries = calculateLeaderboard(
      teams,
      evaluations,
      judgesSnap.size,
    ).map((e) => ({
      rank: e.rank,
      isTied: e.isTied,
      teamName: e.teamName,
      projectTitle: e.projectTitle,
      averageRating: e.averageRating,
      averageFormatted: e.averageFormatted,
      submittedCount: e.submittedCount,
      totalJudges: e.totalJudges,
    }));
    const archiveId = `ev_${Date.now()}`;
    const ref = doc(db, 'eventArchives', archiveId);
    await setDoc(ref, {
      eventName: (settings.eventName || 'Event').slice(0, 160),
      archivedAt: serverTimestamp(),
      archivedBy: archivedBy.slice(0, 160),
      totalJudges: judgesSnap.size,
      totalTeams: teams.length,
      totalSubmissions: evaluations.length,
      entries,
    });
    const check = await getDoc(ref);
    const saved = check.data();
    if (
      !check.exists() ||
      !saved ||
      saved.totalSubmissions !== evaluations.length ||
      !Array.isArray(saved.entries) ||
      saved.entries.length !== entries.length
    ) {
      throw new Error('The archive could not be confirmed. Nothing was reset.');
    }
    return archiveId;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'eventArchives');
  }
}

export interface ResetState {
  status: 'archiving' | 'deleting';
  archiveId: string;
  expectedRatingCount: number;
  startedBy: string;
  updatedAtMs: number;
}

/** A running reset is trusted for this long; after that another admin may take over. */
const RESET_LOCK_STALE_MS = 3 * 60 * 1000;

/** Present while a reset has started but not finished. Admin only. */
export async function getResetState(): Promise<ResetState | null> {
  const snap = await getDoc(doc(db, 'eventResets', 'current'));
  if (!snap.exists()) return null;
  const x = snap.data();
  return {
    status: x.status === 'deleting' ? 'deleting' : 'archiving',
    archiveId: String(x.archiveId ?? ''),
    expectedRatingCount: Number(x.expectedRatingCount ?? 0),
    startedBy: String(x.startedBy ?? ''),
    updatedAtMs: Number(x.updatedAtMs ?? 0),
  };
}

/**
 * Archive the finished event, then reset for the next one. Admin accounts are kept.
 *
 * Safety rules:
 * - Only one reset runs at a time (a marker document taken in a transaction).
 * - Submissions are closed first so no rating can arrive mid-reset.
 * - Before anything is deleted, a failure puts everything back (marker removed,
 *   submissions reopened, nothing lost).
 * - Once deleting has started, submissions stay closed and the marker stays.
 *   Running this again resumes the SAME reset and reuses the original archive;
 *   it never archives a half-deleted event.
 */
export async function archiveAndStartNewEvent(
  settings: EventSettings,
  archivedBy: string,
): Promise<string> {
  const lockRef = doc(db, 'eventResets', 'current');
  const settingsRef = doc(db, 'settings', 'event');
  const wasOpen = settings.submissionsOpen;

  // Identifies this run. If another admin takes over a marker that looked abandoned,
  // this run notices before its next delete and stops.
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

  // 1. Take the marker (or resume a reset that already started deleting).
  let resume: ResetState | null = null;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(lockRef);
      resume = null;
      if (snap.exists()) {
        const d = snap.data();
        const fresh =
          Date.now() - Number(d.updatedAtMs ?? 0) < RESET_LOCK_STALE_MS;
        if (fresh) {
          throw new Error(
            'Another reset is already running. Wait a few minutes and try again.',
          );
        }
        if (d.status === 'deleting') {
          resume = {
            status: 'deleting',
            archiveId: String(d.archiveId ?? ''),
            expectedRatingCount: Number(d.expectedRatingCount ?? 0),
            startedBy: String(d.startedBy ?? ''),
            updatedAtMs: Number(d.updatedAtMs ?? 0),
          };
        }
      }
      tx.set(lockRef, {
        status: resume ? 'deleting' : 'archiving',
        archiveId: resume ? (resume as ResetState).archiveId : '',
        expectedRatingCount: resume
          ? (resume as ResetState).expectedRatingCount
          : 0,
        startedBy: archivedBy.slice(0, 160),
        owner: token,
        updatedAtMs: Date.now(),
      });
    });
  } catch (err) {
    if (err instanceof Error && /already running/.test(err.message)) throw err;
    handleFirestoreError(err, OperationType.WRITE, 'eventResets/current');
  }

  // Undo for failures that happen before anything is deleted.
  const undo = async () => {
    try {
      await writeBatch(db).delete(lockRef).commit();
      if (wasOpen) {
        await updateDoc(settingsRef, {
          submissionsOpen: true,
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      /* the stale marker expires on its own; submissions can be reopened in Controls */
    }
  };

  let archiveId: string;
  if (resume) {
    archiveId = (resume as ResetState).archiveId;
  } else {
    try {
      // 2. Close submissions so no rating can arrive between archive and reset.
      await updateDoc(settingsRef, {
        submissionsOpen: false,
        updatedAt: serverTimestamp(),
      });
      // 3. Save and verify the archive, then confirm nothing changed since.
      archiveId = await archiveCurrentEventResults(settings, archivedBy);
      const saved = await getDoc(doc(db, 'eventArchives', archiveId));
      const archivedRatings = Number(saved.data()?.totalSubmissions ?? 0);
      const now = await getDocs(collection(db, 'evaluations'));
      if (now.size !== archivedRatings) {
        throw new Error(
          'Ratings changed after the archive was saved. Nothing was reset. Try again.',
        );
      }
      // Point of no return: from here a failure keeps submissions closed.
      await updateDoc(lockRef, {
        status: 'deleting',
        archiveId,
        expectedRatingCount: archivedRatings,
        updatedAtMs: Date.now(),
      });
    } catch (err) {
      await undo();
      throw err;
    }
  }

  // 4. Delete and recreate. On failure the marker stays so this can be resumed.
  try {
    await initializeEverythingToZeroWith15Teams(
      { ...settings, submissionsOpen: true },
      {
        clearResetLock: true,
        beforeChunk: async () => {
          await runTransaction(db, async (tx) => {
            const cur = await tx.get(lockRef);
            if (!cur.exists() || cur.data().owner !== token) {
              throw new Error(
                'This reset was taken over by another admin session, so this one stopped.',
              );
            }
            tx.update(lockRef, { updatedAtMs: Date.now() });
          });
        },
      },
    );
  } catch (err) {
    if (err instanceof Error && /taken over/.test(err.message)) throw err;
    throw new Error(
      'The reset did not finish. Your results are archived and submissions stay closed. Run Start New Event again to resume.',
      { cause: err },
    );
  }
  return archiveId;
}

export interface EventArchive {
  id: string;
  eventName: string;
  archivedAtMs: number;
  archivedBy: string;
  totalJudges: number;
  totalTeams: number;
  totalSubmissions: number;
  entries: {
    rank: number;
    isTied?: boolean;
    teamName: string;
    projectTitle?: string;
    averageFormatted: string;
    submittedCount?: number;
  }[];
}

/** Archived results of earlier events, newest first. Admin only (rules enforce it). */
export async function listEventArchives(): Promise<EventArchive[]> {
  try {
    const snap = await getDocs(collection(db, 'eventArchives'));
    return snap.docs
      .map((d) => {
        const x = d.data();
        return {
          id: d.id,
          eventName: String(x.eventName ?? ''),
          archivedAtMs: x.archivedAt?.toMillis?.() ?? 0,
          archivedBy: String(x.archivedBy ?? ''),
          totalJudges: Number(x.totalJudges ?? 0),
          totalTeams: Number(x.totalTeams ?? 0),
          totalSubmissions: Number(x.totalSubmissions ?? 0),
          entries: Array.isArray(x.entries) ? x.entries : [],
        } as EventArchive;
      })
      .sort((a, b) => b.archivedAtMs - a.archivedAtMs);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'eventArchives');
  }
}

export async function resetAllEventDataToZero(
  settings: EventSettings,
): Promise<void> {
  return initializeEverythingToZeroWith15Teams(settings);
}

export async function syncJudgeCountSummary(totalJudges: number): Promise<void> {
  try {
    await setDoc(doc(db, 'publicStats', 'summary'), {
      totalJudges: Math.max(0, totalJudges),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'publicStats/summary');
  }
}
