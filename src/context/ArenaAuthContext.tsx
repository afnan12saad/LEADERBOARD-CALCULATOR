import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { deleteDoc, doc, getDoc } from 'firebase/firestore';
import {
  BOOTSTRAPPED_ADMIN_EMAILS,
  OperationType,
  auth,
  db,
  googleProvider,
  handleFirestoreError,
} from '../firebase';
import type {
  AdminQuota,
  AdminRequest,
  AdminUser,
  EventSettings,
  Judge,
  JudgeSession,
  PublicSummary,
  Team,
} from '../types/arena';
import {
  approveAdminJoinRequest,
  claimAdminSlot,
  claimJudgeSlot,
  createAdminJoinRequest,
  getFirstAdminInfo,
  getLiveAdminQuotaCount,
  registerJudgeByNameEmail,
  rejectAdminJoinRequest,
  subscribeAdminQuota,
  subscribeAdminRequests,
  subscribeEventSettings,
  subscribeMyPendingAdminRequest,
  subscribePublicSummary,
  subscribeTeams,
  verifyAdminCodeAndActivate,
} from '../services/arenaService';
import {
  MAX_ADMIN_USERS,
  validateAdminRegistrationInput,
  validateJudgeNameAndEmail,
} from '../utils/scoring';

function mapFirebaseAuthError(err: unknown): Error {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
  const msg = err instanceof Error ? err.message : String(err);

  if (
    code === 'auth/operation-not-allowed' ||
    code === 'auth/admin-restricted-operation' ||
    msg.includes('CONFIGURATION_NOT_FOUND')
  ) {
    return new Error(
      'This sign-in provider is not enabled in Firebase Console yet. Open Authentication -> Sign-in method, enable Email/Password and Anonymous sign-in, then try again.',
    );
  }
  if (code === 'auth/email-already-in-use') {
    return new Error(
      'An account with this email already exists. Switch to Sign In or use Forgot Password.',
    );
  }
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found'
  ) {
    return new Error('Incorrect email address or password.');
  }
  if (code === 'auth/invalid-email') {
    return new Error('Enter a valid email address.');
  }
  if (code === 'auth/weak-password') {
    return new Error('Password must be at least 8 characters long.');
  }
  if (code === 'auth/too-many-requests') {
    return new Error(
      'Too many requests. Please wait a few minutes before trying again.',
    );
  }
  if (err instanceof Error) return err;
  return new Error(msg);
}

interface ArenaAuthContextValue {
  user: User | null;
  authReady: boolean;
  isAdmin: boolean;
  isFirstAdmin: boolean;
  adminQuota: AdminQuota;
  firstAdminInfo: { email: string; uid: string; name: string } | null;
  pendingAdminRequest: AdminRequest | null;
  adminRequests: AdminRequest[];
  judgeSession: JudgeSession | null;
  judgeProfile: Judge | null;
  settings: EventSettings | null;
  publicSummary: PublicSummary | null;
  teams: Team[];
  dataReady: boolean;
  signInWithGoogle: () => Promise<User>;
  signInAdminWithEmail: (email: string, password: string) => Promise<User>;
  registerAdminWithEmail: (params: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
  }) => Promise<User>;
  resendAdminVerificationEmail: () => Promise<void>;
  refreshAdminVerification: () => Promise<boolean>;
  sendAdminPasswordReset: (email: string) => Promise<void>;
  requestAdminJoin: (name: string) => Promise<AdminRequest>;
  verifyAdminCode: (code: string) => Promise<boolean>;
  approveRequest: (request: AdminRequest) => Promise<void>;
  rejectRequest: (requestUid: string) => Promise<void>;
  signInJudgeByNameAndEmail: (name: string, email: string) => Promise<Judge>;
  claimJudge: (judgeCode: string, accessCode: string) => Promise<Judge>;
  leaveJudgeSession: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const ArenaAuthContext = createContext<ArenaAuthContextValue | null>(null);

export function ArenaAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isFirstAdmin, setIsFirstAdmin] = useState(false);
  const [adminQuota, setAdminQuota] = useState<AdminQuota>({
    count: 0,
    maxAdmins: MAX_ADMIN_USERS,
  });
  const [firstAdminInfo, setFirstAdminInfo] = useState<{
    email: string;
    uid: string;
    name: string;
  } | null>(null);
  const [pendingAdminRequest, setPendingAdminRequest] =
    useState<AdminRequest | null>(null);
  const [adminRequests, setAdminRequests] = useState<AdminRequest[]>([]);

  const [judgeSession, setJudgeSession] = useState<JudgeSession | null>(null);
  const [judgeProfile, setJudgeProfile] = useState<Judge | null>(null);

  const [settings, setSettings] = useState<EventSettings | null>(null);
  const [publicSummary, setPublicSummary] = useState<PublicSummary | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [dataReady, setDataReady] = useState(false);

  const resolveRoles = useCallback(async (currentUser: User | null) => {
    if (!currentUser) {
      setIsAdmin(false);
      setIsFirstAdmin(false);
      setPendingAdminRequest(null);
      setJudgeSession(null);
      setJudgeProfile(null);
      setAuthReady(true);
      return;
    }

    let adminFlag = false;
    let firstAdminFlag = false;

    if (currentUser.emailVerified) {
      try {
        const adminDoc = await getDoc(doc(db, 'admins', currentUser.uid));
        if (adminDoc.exists()) {
          adminFlag = true;
          const adminData = adminDoc.data() as AdminUser;
          firstAdminFlag = Boolean(adminData.isFirstAdmin);
        } else if (
          currentUser.email &&
          BOOTSTRAPPED_ADMIN_EMAILS.includes(currentUser.email.toLowerCase())
        ) {
          const quotaSnap = await getDoc(doc(db, 'publicStats', 'adminQuota'));
          if (
            !quotaSnap.exists() ||
            (quotaSnap.data() as AdminQuota).count === 0
          ) {
            adminFlag = true;
            firstAdminFlag = true;
          }
        }
      } catch {
        adminFlag = false;
      }
    }

    setIsAdmin(adminFlag);
    setIsFirstAdmin(firstAdminFlag);

    // If user is verified but not an admin, check if they have a pending admin request
    if (currentUser.emailVerified && !adminFlag) {
      try {
        const reqSnap = await getDoc(doc(db, 'adminRequests', currentUser.uid));
        if (reqSnap.exists()) {
          const reqData = reqSnap.data() as AdminRequest;
          setPendingAdminRequest(reqData);
          if (reqData.status === 'approved') {
            // Automatically claim admin slot now that request was approved
            try {
              await claimAdminSlot(currentUser, reqData.name);
              setIsAdmin(true);
            } catch {
              // ignore
            }
          }
        } else {
          setPendingAdminRequest(null);
        }
      } catch {
        setPendingAdminRequest(null);
      }
    } else {
      setPendingAdminRequest(null);
    }

    // Check Judge Session
    try {
      const sessionSnap = await getDoc(
        doc(db, 'judgeSessions', currentUser.uid),
      );
      if (sessionSnap.exists()) {
        const session = sessionSnap.data() as JudgeSession;
        const judgeSnap = await getDoc(doc(db, 'judges', session.judgeId));
        if (judgeSnap.exists()) {
          const j = judgeSnap.data() as Judge;
          if (j.active && j.uid === currentUser.uid) {
            setJudgeSession(session);
            setJudgeProfile(j);
          } else {
            setJudgeSession(null);
            setJudgeProfile(null);
          }
        } else {
          setJudgeSession(null);
          setJudgeProfile(null);
        }
      } else {
        setJudgeSession(null);
        setJudgeProfile(null);
      }
    } catch {
      setJudgeSession(null);
      setJudgeProfile(null);
    }

    setAuthReady(true);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      void resolveRoles(currentUser);
    });
    return () => unsub();
  }, [resolveRoles]);

  // Subscribe to global event data
  useEffect(() => {
    let settingsLoaded = false;
    let teamsLoaded = false;

    const markReady = () => {
      if (settingsLoaded && teamsLoaded) {
        setDataReady(true);
      }
    };

    const unsubSettings = subscribeEventSettings((s) => {
      setSettings(s);
      settingsLoaded = true;
      markReady();
    });
    const unsubSummary = subscribePublicSummary((sum) => {
      setPublicSummary(sum);
    });
    const unsubQuota = subscribeAdminQuota((quota) => {
      setAdminQuota(quota);
    });
    const unsubTeams = subscribeTeams((t) => {
      setTeams(t);
      teamsLoaded = true;
      markReady();
    });

    void getFirstAdminInfo().then((info) => {
      setFirstAdminInfo(info);
    });

    return () => {
      unsubSettings();
      unsubSummary();
      unsubQuota();
      unsubTeams();
    };
  }, []);

  // Real-time listener for all admin requests if current user is admin
  useEffect(() => {
    if (!isAdmin) {
      setAdminRequests([]);
      return;
    }
    const unsub = subscribeAdminRequests((requests) => {
      setAdminRequests(requests);
    });
    return () => unsub();
  }, [isAdmin]);

  // Real-time listener for current user's own admin request when awaiting approval
  useEffect(() => {
    if (!user || isAdmin) return;
    const unsub = subscribeMyPendingAdminRequest(user.uid, (req) => {
      setPendingAdminRequest(req);
      if (req && req.status === 'approved') {
        // First admin just approved the request in real time!
        void claimAdminSlot(user, req.name).then(() => {
          void resolveRoles(user);
        });
      }
    });
    return () => unsub();
  }, [user, isAdmin, resolveRoles]);

  const signInWithGoogle = useCallback(async () => {
    const cred = await signInWithPopup(auth, googleProvider);
    await resolveRoles(cred.user);
    return cred.user;
  }, [resolveRoles]);

  const signInAdminWithEmail = useCallback(
    async (email: string, password: string) => {
      const cleanEmail = email.trim();
      if (!cleanEmail || !password) {
        throw new Error('Enter both your email address and password.');
      }

      try {
        const cred = await signInWithEmailAndPassword(
          auth,
          cleanEmail,
          password,
        );
        await cred.user.getIdToken(true);
        setUser(cred.user);

        if (!cred.user.emailVerified) {
          await resolveRoles(cred.user);
          return cred.user;
        }

        const existingAdmin = await getDoc(doc(db, 'admins', cred.user.uid));
        if (existingAdmin.exists()) {
          await resolveRoles(cred.user);
          return cred.user;
        }

        // Not in admins: check if first admin or candidate
        const liveCount = await getLiveAdminQuotaCount();
        const isBootstrap =
          BOOTSTRAPPED_ADMIN_EMAILS.includes(cleanEmail.toLowerCase()) ||
          liveCount === 0;

        if (isBootstrap) {
          await claimAdminSlot(cred.user);
        } else {
          // Check if user has an existing request
          const reqSnap = await getDoc(
            doc(db, 'adminRequests', cred.user.uid),
          );
          if (reqSnap.exists()) {
            const req = reqSnap.data() as AdminRequest;
            setPendingAdminRequest(req);
            if (req.status === 'approved') {
              await claimAdminSlot(cred.user, req.name);
            }
          } else {
            // Automatically initialize a join request with 6-digit code for the new admin
            const newReq = await createAdminJoinRequest({
              user: cred.user,
              name: cred.user.displayName || cleanEmail.split('@')[0],
            });
            setPendingAdminRequest(newReq);
          }
        }

        await resolveRoles(cred.user);
        return cred.user;
      } catch (err) {
        throw mapFirebaseAuthError(err);
      }
    },
    [resolveRoles],
  );

  const registerAdminWithEmail = useCallback(
    async (params: {
      name: string;
      email: string;
      password: string;
      confirmPassword: string;
    }) => {
      const validationError = validateAdminRegistrationInput({
        ...params,
      });
      if (validationError) {
        throw new Error(validationError);
      }

      try {
        const cred = await createUserWithEmailAndPassword(
          auth,
          params.email.trim(),
          params.password,
        );
        await updateProfile(cred.user, {
          displayName: params.name.trim().slice(0, 100),
        });
        await sendEmailVerification(cred.user, {
          url: `${window.location.origin}/admin/login`,
        });
        setUser(cred.user);

        const liveCount = await getLiveAdminQuotaCount();
        const isBootstrap =
          BOOTSTRAPPED_ADMIN_EMAILS.includes(
            params.email.trim().toLowerCase(),
          ) || liveCount === 0;

        if (!isBootstrap) {
          // Create an onboarding request with a 6-digit verification code targeted at the first admin's email
          const newReq = await createAdminJoinRequest({
            user: cred.user,
            name: params.name.trim(),
          });
          setPendingAdminRequest(newReq);
        }

        await resolveRoles(cred.user);
        return cred.user;
      } catch (err) {
        throw mapFirebaseAuthError(err);
      }
    },
    [resolveRoles],
  );

  const resendAdminVerificationEmail = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) {
      throw new Error('Sign in with your email and password first.');
    }
    try {
      await sendEmailVerification(current, {
        url: `${window.location.origin}/admin/login`,
      });
    } catch (err) {
      throw mapFirebaseAuthError(err);
    }
  }, []);

  const refreshAdminVerification = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return false;
    await current.reload();
    await current.getIdToken(true);
    setUser(auth.currentUser);
    if (!current.emailVerified) {
      return false;
    }

    const liveCount = await getLiveAdminQuotaCount();
    const isBootstrap =
      BOOTSTRAPPED_ADMIN_EMAILS.includes(
        (current.email ?? '').toLowerCase(),
      ) || liveCount === 0;

    if (isBootstrap) {
      await claimAdminSlot(current);
    } else {
      const reqSnap = await getDoc(doc(db, 'adminRequests', current.uid));
      if (!reqSnap.exists()) {
        const newReq = await createAdminJoinRequest({
          user: current,
          name: current.displayName || 'Co-Administrator',
        });
        setPendingAdminRequest(newReq);
      } else {
        const req = reqSnap.data() as AdminRequest;
        setPendingAdminRequest(req);
        if (req.status === 'approved') {
          await claimAdminSlot(current, req.name);
        }
      }
    }

    await resolveRoles(current);
    return true;
  }, [resolveRoles]);

  const sendAdminPasswordReset = useCallback(async (email: string) => {
    const cleanEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new Error('Enter a valid email address.');
    }
    try {
      await sendPasswordResetEmail(auth, cleanEmail, {
        url: `${window.location.origin}/admin/login`,
      });
    } catch (err) {
      throw mapFirebaseAuthError(err);
    }
  }, []);

  const requestAdminJoin = useCallback(async (name: string) => {
    const current = auth.currentUser;
    if (!current) {
      throw new Error('Sign in with email and password first.');
    }
    const req = await createAdminJoinRequest({
      user: current,
      name,
    });
    setPendingAdminRequest(req);
    return req;
  }, []);

  const verifyAdminCode = useCallback(
    async (code: string) => {
      const current = auth.currentUser;
      if (!current) {
        throw new Error('You must be signed in to verify code.');
      }
      const success = await verifyAdminCodeAndActivate(current, code);
      if (success) {
        await resolveRoles(current);
      }
      return success;
    },
    [resolveRoles],
  );

  const approveRequest = useCallback(
    async (request: AdminRequest) => {
      const current = auth.currentUser;
      if (!current || !isAdmin) {
        throw new Error('Only active administrators can approve access.');
      }
      await approveAdminJoinRequest(request, current.email || 'Primary Admin');
    },
    [isAdmin],
  );

  const rejectRequest = useCallback(
    async (requestUid: string) => {
      if (!isAdmin) {
        throw new Error('Only active administrators can reject requests.');
      }
      await rejectAdminJoinRequest(requestUid);
    },
    [isAdmin],
  );

  const signInJudgeByNameAndEmail = useCallback(
    async (name: string, email: string) => {
      const validationErr = validateJudgeNameAndEmail(name, email);
      if (validationErr) {
        throw new Error(validationErr);
      }

      let current = auth.currentUser;
      if (
        current &&
        current.providerData.some((p) => p.providerId === 'password')
      ) {
        throw new Error(
          'You are currently signed in as an Administrator. Sign out from Admin Console before entering as a Judge.',
        );
      }

      if (!current) {
        try {
          const cred = await signInAnonymously(auth);
          current = cred.user;
          setUser(cred.user);
        } catch (err) {
          throw mapFirebaseAuthError(err);
        }
      }

      const profile = await registerJudgeByNameEmail(current, name, email);
      setJudgeSession({
        uid: current.uid,
        judgeId: profile.id,
        accessCode: 'SELF_AUTH',
      });
      setJudgeProfile(profile);
      return profile;
    },
    [],
  );

  const claimJudge = useCallback(
    async (judgeCode: string, accessCode: string) => {
      const current = auth.currentUser;
      if (!current) {
        throw new Error('Sign in with Google first to bind your Judge ID.');
      }
      const profile = await claimJudgeSlot(current, judgeCode, accessCode);
      setJudgeSession({
        uid: current.uid,
        judgeId: profile.id,
        accessCode: accessCode.trim(),
      });
      setJudgeProfile(profile);
      return profile;
    },
    [],
  );

  const leaveJudgeSession = useCallback(async () => {
    const current = auth.currentUser;
    if (current) {
      try {
        await deleteDoc(doc(db, 'judgeSessions', current.uid));
      } catch (err) {
        handleFirestoreError(
          err,
          OperationType.DELETE,
          `judgeSessions/${current.uid}`,
        );
      }
    }
    setJudgeSession(null);
    setJudgeProfile(null);
  }, []);

  const logoutAll = useCallback(async () => {
    await signOut(auth);
    setIsAdmin(false);
    setIsFirstAdmin(false);
    setPendingAdminRequest(null);
    setJudgeSession(null);
    setJudgeProfile(null);
  }, []);

  return (
    <ArenaAuthContext.Provider
      value={{
        user,
        authReady,
        isAdmin,
        isFirstAdmin,
        adminQuota,
        firstAdminInfo,
        pendingAdminRequest,
        adminRequests,
        judgeSession,
        judgeProfile,
        settings,
        publicSummary,
        teams,
        dataReady,
        signInWithGoogle,
        signInAdminWithEmail,
        registerAdminWithEmail,
        resendAdminVerificationEmail,
        refreshAdminVerification,
        sendAdminPasswordReset,
        requestAdminJoin,
        verifyAdminCode,
        approveRequest,
        rejectRequest,
        signInJudgeByNameAndEmail,
        claimJudge,
        leaveJudgeSession,
        logoutAll,
      }}
    >
      {children}
    </ArenaAuthContext.Provider>
  );
}

export function useArenaAuth(): ArenaAuthContextValue {
  const ctx = useContext(ArenaAuthContext);
  if (!ctx) {
    throw new Error('useArenaAuth must be used inside ArenaAuthProvider');
  }
  return ctx;
}
