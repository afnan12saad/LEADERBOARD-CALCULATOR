import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Award,
  Eye,
  Lock,
  Maximize2,
  Minimize2,
  Radio,
} from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
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

export function ProjectorPage() {
  const { settings, publicSummary, teams, isAdmin, judgeProfile } =
    useArenaAuth();
  const [publishedBoard, setPublishedBoard] =
    useState<PublishedLeaderboard | null>(null);
  const [adminJudges, setAdminJudges] = useState<Judge[]>([]);
  const [adminEvaluations, setAdminEvaluations] = useState<Evaluation[]>([]);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const resultsPublished = Boolean(settings?.resultsPublished);

  useEffect(() => {
    return subscribePublishedLeaderboard(
      (board) => setPublishedBoard(board),
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

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen().catch(() => {});
    } else {
      await document.exitFullscreen().catch(() => {});
    }
  };

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

  const eventName = settings?.eventName || DEFAULT_EVENT_SETTINGS.eventName;
  const collegeName =
    settings?.collegeName || DEFAULT_EVENT_SETTINGS.collegeName;
  const totalJudges = publicSummary?.totalJudges ?? 0;
  const totalTeams = teams.length;
  const totalPossible = totalJudges * totalTeams;
  const totalSubmissions = teams.reduce(
    (sum, t) => sum + (t.submittedCount || 0),
    0,
  );
  const overallProgress =
    totalPossible > 0
      ? Math.min(100, Math.round((totalSubmissions / totalPossible) * 100))
      : 0;

  const adminLiveEntries = useMemo(() => {
    if (!isAdmin) return [];
    const activeCount = adminJudges.filter((j) => j.active).length;
    return calculateLeaderboard(
      teams,
      adminEvaluations,
      activeCount || totalJudges,
      settings?.tieBreakerMode ?? 'tie',
    );
  }, [
    isAdmin,
    teams,
    adminEvaluations,
    adminJudges,
    totalJudges,
    settings?.tieBreakerMode,
  ]);

  const showPublished =
    resultsPublished &&
    publishedBoard &&
    publishedBoard.published &&
    publishedBoard.entries.length > 0;

  const showAdminOnlyPreview = isAdmin && !resultsPublished;

  return (
    <div className="min-h-screen flex flex-col bg-[#071422] text-slate-100">
      {/* Projector Top Bar */}
      <header className="bg-[#06101B] border-b border-[#183152] px-6 lg:px-10 py-4">
        <div className="max-w-[1440px] mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              <BrandMark className="w-8 h-8" />
              <span className="font-display font-bold text-xl sm:text-2xl tracking-tight text-white">
                PROJECT ARENA
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#16A34A] text-white text-xs font-bold">
                <Radio className="w-3.5 h-3.5" />
                Live
              </span>
            </div>
            <p className="text-sm sm:text-base text-slate-300">
              {eventName} | {collegeName}
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              aria-label={
                isFullscreen ? 'Exit fullscreen mode' : 'Enter fullscreen mode'
              }
              className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#0D1E33] border border-[#1E3A5F] hover:bg-[#132A46] text-slate-200 text-xs font-semibold transition-colors"
            >
              {isFullscreen ? (
                <Minimize2 className="w-4 h-4" />
              ) : (
                <Maximize2 className="w-4 h-4" />
              )}
              {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            </button>

            {!isFullscreen && (
              <Link
                to={judgeProfile ? '/judge/dashboard' : isAdmin ? '/admin' : '/'}
                className="min-h-[42px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#1E3A5F] bg-[#0D1E33] text-slate-200 text-xs font-semibold hover:bg-[#132A46] transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                {judgeProfile ? 'Judge Dashboard' : isAdmin ? 'Admin Console' : 'Home'}
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 lg:px-10 py-8 space-y-8">
        {/* Centered Whole-Event Countdown Header Card */}
        <section
          aria-label="Whole Event Countdown Timer"
          className="flex flex-col items-center justify-center py-1"
        >
          <LiveTimerDisplay
            settings={settings}
            variant="split"
            eventName={eventName}
          />
        </section>

        {/* Live Event Participation Progress */}
        <section className="max-w-3xl mx-auto bg-[#0D1E33] border border-[#1E3A5F] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-200">
              Overall Evaluation Progress
            </span>
            <span className="font-mono-tabular text-xl font-bold text-[#F5B942]">
              {overallProgress}%
            </span>
          </div>

          <div className="w-full h-3 bg-[#071422] rounded-md overflow-hidden">
            <div
              className="h-full bg-[#2563EB] transition-all duration-300"
              style={{ width: `${overallProgress}%` }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm text-slate-300 font-mono-tabular">
            <span>
              {totalSubmissions} / {totalPossible} Ratings Submitted
            </span>
            <span>
              {totalTeams} Teams | {totalJudges} Judges
            </span>
          </div>
        </section>

        {/* Leaderboard Area */}
        {showPublished ? (
          <section className="space-y-6 animate-reveal">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 max-w-4xl mx-auto">
              <div className="flex items-center gap-2.5">
                <Award className="w-6 h-6 text-[#F5B942]" />
                <h2 className="text-2xl sm:text-3xl font-display font-bold text-white">
                  Official Top 2 Winners & Standings
                </h2>
              </div>
              <p className="text-sm text-slate-400">
                Ranked by average overall star rating (out of 5)
              </p>
            </div>

            <PodiumShowcase
              entries={publishedBoard.entries}
              teams={teams}
              showProjectTitle
            />
          </section>
        ) : showAdminOnlyPreview ? (
          <section className="space-y-6 animate-reveal">
            <div className="max-w-4xl mx-auto p-5 rounded-xl bg-[#0D1E33] border border-[#F5B942]/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-lg bg-[#142D4C] text-[#F5B942] flex items-center justify-center shrink-0">
                  <Lock className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-display font-bold text-white">
                    Admin-Only Live Leaderboard Preview
                  </h2>
                  <p className="text-sm text-slate-300">
                    Hidden from judges and participants. Click Release Final
                    Results when ready to show the Top 2 winners to everyone.
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
                {releaseBusy ? 'Releasing...' : 'Release Results to All Users'}
              </button>
            </div>

            {adminLiveEntries.length > 0 ? (
              <PodiumShowcase
                entries={adminLiveEntries}
                teams={teams}
                showProjectTitle
              />
            ) : (
              <div className="max-w-3xl mx-auto bg-[#0D1E33] border border-[#1E3A5F] rounded-xl p-8 text-center text-sm text-slate-400">
                No teams registered yet. Add participating teams in the Admin
                Console to track live rankings.
              </div>
            )}
          </section>
        ) : (
          <section className="max-w-2xl mx-auto bg-[#0D1E33] border border-[#1E3A5F] rounded-xl p-8 sm:p-10 text-center space-y-4">
            <div className="w-12 h-12 rounded-lg bg-[#142D4C] text-[#F5B942] flex items-center justify-center mx-auto">
              <Lock className="w-6 h-6" />
            </div>
            <h2 className="text-xl sm:text-2xl font-display font-bold text-white">
              Leaderboard & Results Restricted to Admin
            </h2>
            <p className="text-sm text-slate-300 max-w-xl mx-auto leading-relaxed">
              Team rankings, average scores, and leaderboard results remain
              hidden from judges and participants during evaluation. Once the
              Event Admin releases the final results at the end, the Top 2
              winners will appear here automatically.
            </p>
            {judgeProfile && (
              <div className="pt-2">
                <Link
                  to="/judge/dashboard"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#2563EB] text-white text-sm font-semibold hover:bg-[#1d4ed8] transition-colors"
                >
                  Return to Judge Dashboard
                </Link>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
