import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, Lock } from 'lucide-react';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';
import { LiveTimerDisplay } from '../components/LiveTimerDisplay';
import { PodiumShowcase } from '../components/PodiumShowcase';
import { useArenaAuth } from '../context/ArenaAuthContext';
import {
  DEFAULT_EVENT_SETTINGS,
  publishOrHideResults,
  subscribeAllEvaluations,
  subscribeAllJudges,
  subscribePublishedLeaderboard,
} from '../services/arenaService';
import type { Evaluation, Judge, PublishedLeaderboard } from '../types/arena';
import { calculateLeaderboard } from '../utils/scoring';

export function FinalResultsPage() {
  const { settings, teams, isAdmin, judgeProfile, publicSummary } =
    useArenaAuth();
  const [board, setBoard] = useState<PublishedLeaderboard | null>(null);
  const [adminJudges, setAdminJudges] = useState<Judge[]>([]);
  const [adminEvaluations, setAdminEvaluations] = useState<Evaluation[]>([]);
  const [releaseBusy, setReleaseBusy] = useState(false);

  const resultsPublished = Boolean(settings?.resultsPublished);

  useEffect(() => {
    return subscribePublishedLeaderboard(
      (data) => setBoard(data),
      resultsPublished || isAdmin,
    );
  }, [resultsPublished, isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      setAdminJudges([]);
      setAdminEvaluations([]);
      return;
    }
    const unsubJudges = subscribeAllJudges(setAdminJudges);
    const unsubEvals = subscribeAllEvaluations(setAdminEvaluations);
    return () => {
      unsubJudges();
      unsubEvals();
    };
  }, [isAdmin]);

  const adminLiveEntries = useMemo(() => {
    if (!isAdmin) return [];
    const activeCount = adminJudges.filter((j) => j.active).length;
    return calculateLeaderboard(
      teams,
      adminEvaluations,
      activeCount || publicSummary?.totalJudges || 0,
      settings?.tieBreakerMode ?? 'tie',
    );
  }, [
    isAdmin,
    teams,
    adminEvaluations,
    adminJudges,
    publicSummary?.totalJudges,
    settings?.tieBreakerMode,
  ]);

  const handleReleaseResults = async () => {
    if (!isAdmin) return;
    setReleaseBusy(true);
    try {
      await publishOrHideResults({
        publish: true,
        teams,
        judges: adminJudges,
        evaluations: adminEvaluations,
        settings: settings ?? { ...DEFAULT_EVENT_SETTINGS },
      });
    } finally {
      setReleaseBusy(false);
    }
  };

  const isRevealed =
    resultsPublished && board && board.published && board.entries.length > 0;

  const eventName = settings?.eventName || DEFAULT_EVENT_SETTINGS.eventName;
  const collegeName =
    settings?.collegeName || DEFAULT_EVENT_SETTINGS.collegeName;

  return (
    <div className="min-h-screen flex flex-col bg-[#071422] text-slate-100">
      <SiteHeader />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
        <div className="text-center max-w-2xl mx-auto space-y-2">
          <p className="text-xs font-semibold text-[#F5B942]">
            Official Event Standings
          </p>
          <h1 className="text-3xl sm:text-4xl font-display font-bold text-white">
            {eventName}
          </h1>
          <p className="text-sm text-slate-400">{collegeName}</p>
        </div>

        {/* Whole Event Countdown Card */}
        <div className="flex justify-center">
          <LiveTimerDisplay
            settings={settings}
            variant="split"
            eventName={eventName}
          />
        </div>

        {isRevealed ? (
          <div className="space-y-8 animate-reveal">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#183152] pb-4">
              <h2 className="text-lg font-display font-bold text-white">
                Top 2 Winners & Final Standings
              </h2>
              <span className="text-xs text-slate-400 font-mono-tabular">
                {board.totalSubmissions} Total Ratings Across {board.totalTeams}{' '}
                Teams
              </span>
            </div>

            <PodiumShowcase
              entries={board.entries}
              teams={teams}
              showProjectTitle
            />
          </div>
        ) : isAdmin ? (
          <div className="space-y-8 animate-reveal">
            <div className="p-5 rounded-xl bg-[#0D1E33] border border-[#F5B942]/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-[#142D4C] text-[#F5B942] flex items-center justify-center shrink-0">
                  <Lock className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base font-display font-bold text-white">
                    Admin-Only Standings Preview
                  </h2>
                  <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
                    Judges and participants cannot see these standings yet.
                    Release final results when judging finishes to reveal the
                    Top 2 spotlight podium.
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={releaseBusy}
                onClick={() => void handleReleaseResults()}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[#16A34A] text-white text-sm font-semibold hover:bg-[#15803d] transition-colors shrink-0 disabled:opacity-60"
              >
                <Eye className="w-4 h-4" />
                {releaseBusy ? 'Releasing...' : 'Release Final Results'}
              </button>
            </div>

            {adminLiveEntries.length > 0 ? (
              <PodiumShowcase
                entries={adminLiveEntries}
                teams={teams}
                showProjectTitle
              />
            ) : (
              <div className="bg-[#0D1E33] border border-[#1E3A5F] rounded-xl p-8 text-center text-sm text-slate-400">
                No teams registered yet (0 Teams, 0 Judges, 0 Ratings).
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-xl mx-auto bg-[#0D1E33] border border-[#1E3A5F] rounded-xl p-8 sm:p-10 text-center space-y-4">
            <div className="w-12 h-12 rounded-lg bg-[#142D4C] text-[#F5B942] flex items-center justify-center mx-auto">
              <Lock className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-display font-bold text-white">
              Final Results Are Locked Until Admin Release
            </h2>
            <p className="text-sm text-slate-300 leading-relaxed">
              Leaderboard rankings and scores are restricted exclusively to
              event administrators during judging. Once the Event Admin releases
              the final results at the end, the Top 2 winners and standings will
              appear here for everyone.
            </p>
            <div className="pt-2 flex flex-wrap justify-center gap-3">
              {judgeProfile && (
                <Link
                  to="/judge/dashboard"
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#2563EB] text-white text-sm font-semibold hover:bg-[#1d4ed8] transition-colors"
                >
                  Return to Judge Dashboard
                </Link>
              )}
              <Link
                to="/"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[#24436B] bg-[#091829] text-slate-200 text-sm font-semibold hover:bg-[#102640] transition-colors"
              >
                Return Home
              </Link>
            </div>
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
