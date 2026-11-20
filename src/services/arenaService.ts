import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  orderBy,
  query,
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

export async function verifyAdminCodeAndActivate(
  user: User,
  enteredCode: string,
): Promise<boolean> {
  const reqSnap = await getDoc(doc(db, 'adminRequests', user.uid));
  if (!reqSnap.exists()) {
    throw new Error('No pending administrator request found for your account.');
  }
  const req = reqSnap.data() as AdminRequest;
  const cleanCode = enteredCode.trim().replace(/\s+/g, '');
  if (req.verificationCode.trim() !== cleanCode) {
    throw new Error(
      'Invalid verification code. Please check the 6-digit code sent to the primary administrator.',
    );
  }

  const batch = writeBatch(db);
  batch.update(doc(db, 'adminRequests', user.uid), {
    status: 'approved',
    approvedAt: serverTimestamp(),
    approvedBy: 'Verification Code Verification',
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'admins', user.uid), {
    uid: user.uid,
    email: req.email,
    name: req.name,
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
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `admins/${user.uid}`);
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

  const summarySnap = await getDoc(doc(db, 'publicStats', 'summary'));
  const currentTotalJudges = summarySnap.exists()
    ? Number((summarySnap.data() as PublicSummary).totalJudges || 0)
    : 0;

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
  batch.set(doc(db, 'publicStats', 'summary'), {
    totalJudges: Math.max(0, currentTotalJudges) + 1,
    updatedAt: serverTimestamp(),
  });

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
      tieBreakerMode: settings.tieBreakerMode,
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

    const batch = writeBatch(db);
    for (const d of evalsSnap.docs) batch.delete(d.ref);
    for (const d of teamsSnap.docs) batch.delete(d.ref);
    for (const d of judgesSnap.docs) batch.delete(d.ref);
    for (const d of sessionsSnap.docs) batch.delete(d.ref);
    for (const d of credsSnap.docs) batch.delete(d.ref);

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
