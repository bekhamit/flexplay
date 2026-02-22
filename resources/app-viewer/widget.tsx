/**
 * app-viewer — universal widget used by join-app.
 * Renders either a poll or quiz UI based on the appType prop.
 */
import {
  McpUseProvider,
  useCallTool,
  useWidget,
  type WidgetMetadata,
} from "mcp-use/react";
import { z } from "zod";
import React, { useEffect, useRef, useState } from "react";
import "../styles.css";

const pollQuestionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
});

const quizQuestionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  correctIndex: z.number(),
  timeLimit: z.number(),
});

const answerRecordSchema = z.object({
  answerIndex: z.number(),
  timeMs: z.number(),
  playerName: z.string(),
});

const propsSchema = z.object({
  appId: z.string(),
  appType: z.enum(["poll", "quiz"]),
  isHost: z.boolean(),
  playerName: z.string(),
  playerId: z.string(),

  // Poll fields
  title: z.string(),
  questions: z.array(pollQuestionSchema),
  multiChoice: z.boolean(),
  currentQuestion: z.number(),
  phase: z.string(),
  votes: z.record(z.string(), z.record(z.string(), z.array(z.string()))),

  // Quiz fields
  quizTitle: z.string(),
  quizQuestions: z.array(quizQuestionSchema),
  quizPhase: z.string(),
  questionStartTime: z.number().nullable(),
  answers: z.record(z.string(), z.record(z.string(), answerRecordSchema)),
  scores: z.record(z.string(), z.object({ name: z.string(), score: z.number() })),
  players: z.record(z.string(), z.string()),
});

export const widgetMetadata: WidgetMetadata = {
  description: "Universal app viewer for joined polls and quizzes",
  props: propsSchema,
  exposeAsTool: false,
  metadata: {
    invoking: "Joining app...",
    invoked: "Joined!",
  },
};

type Props = z.infer<typeof propsSchema>;

type AppViewerState = {
  confirmedName: string | null;
};

type AppStateResult = {
  found: boolean;
  appType?: string;
  currentQuestion?: number;
  phase?: string;
  votes?: Record<string, Record<string, string[]>>;
  questionStartTime?: number | null;
  answers?: Record<string, Record<string, { answerIndex: number; timeMs: number; playerName: string }>>;
  scores?: Record<string, { name: string; score: number }>;
  players?: Record<string, string>;
};

// ─── Shared helpers ────────────────────────────────────────────────────────────

const OPTION_COLORS = [
  { bg: "#e74c3c", icon: "▲", bar: "#ef4444" },
  { bg: "#3498db", icon: "◆", bar: "#3b82f6" },
  { bg: "#f39c12", icon: "●", bar: "#facc15" },
  { bg: "#27ae60", icon: "■", bar: "#22c55e" },
  { bg: "#9b59b6", icon: "★", bar: "#a855f7" },
  { bg: "#e67e22", icon: "♦", bar: "#f97316" },
];

function totalVotesForQ(qVotes: Record<string, string[]>): number {
  return Object.values(qVotes).flat().length;
}

function pct(qVotes: Record<string, string[]>, option: string): number {
  const total = totalVotesForQ(qVotes);
  return total === 0 ? 0 : Math.round(((qVotes[option]?.length ?? 0) / total) * 100);
}

// ─── Name Entry ─────────────────────────────────────────────────────────────────

function NameEntry({
  defaultName,
  appType,
  title,
  appId,
  onConfirm,
}: {
  defaultName: string;
  appType: "poll" | "quiz";
  title: string;
  appId: string;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(defaultName || "");

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
      <div className="px-6 pt-8 pb-4 text-center">
        <div className="text-4xl mb-3">{appType === "poll" ? "📊" : "🧠"}</div>
        <h2 className="text-xl font-bold text-default">{title || (appType === "poll" ? "Live Poll" : "Quiz")}</h2>
        <p className="text-sm text-secondary mt-1">
          Code: <span className="font-mono font-bold text-info">#{appId}</span>
        </p>
      </div>
      <div className="px-6 pb-6">
        <label className="block text-sm font-semibold text-default mb-2">What's your name?</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="Enter your name..."
          maxLength={20}
          autoFocus
          className="w-full px-4 py-3 rounded-xl border border-default bg-surface text-default text-base placeholder:text-secondary/50 focus:outline-none focus:ring-2 focus:ring-info/40 focus:border-info transition-all"
        />
        <button
          onClick={handleSubmit}
          disabled={!name.trim()}
          className="w-full mt-3 py-3.5 rounded-xl bg-info text-white font-bold text-base hover:opacity-90 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Join {appType === "poll" ? "Poll" : "Quiz"} →
        </button>
      </div>
    </div>
  );
}

// ─── Poll View ─────────────────────────────────────────────────────────────────

function PollView({
  props,
  sendFollowUpMessage,
}: {
  props: Props;
  sendFollowUpMessage: (msg: string) => void;
}) {
  const { callToolAsync: getState } = useCallTool("get-app-state");
  const { callToolAsync: castVote, isPending: isVoting } = useCallTool("cast-vote");
  const { callToolAsync: advanceQuestion, isPending: isAdvancing } = useCallTool("next-question");

  const [currentQ, setCurrentQ] = useState(props.currentQuestion ?? 0);
  const [phase, setPhase] = useState(props.phase ?? "voting");
  const [liveVotes, setLiveVotes] = useState<Record<string, Record<string, string[]>>>(props.votes ?? {});
  const [votedQuestions, setVotedQuestions] = useState<Record<string, string[]>>({});
  const [copied, setCopied] = useState(false);
  const [voteError, setVoteError] = useState("");

  const currentQVoted = votedQuestions[String(currentQ)] ?? [];
  const hasVotedCurrentQ = currentQVoted.length > 0;

  // Clear vote error when question changes
  useEffect(() => {
    setVoteError("");
  }, [currentQ]);

  // Poll for live updates
  useEffect(() => {
    const poll = async () => {
      try {
        const result = await getState({ appId: props.appId });
        const data = result?.structuredContent as AppStateResult | undefined;
        if (data?.found) {
          if (data.votes) setLiveVotes(data.votes);
          if (data.currentQuestion !== undefined) setCurrentQ(data.currentQuestion);
          if (data.phase) setPhase(data.phase);
        }
      } catch { /* silent */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [props.appId]);

  const handleVote = async (option: string) => {
    if (isVoting) return;
    setVoteError("");
    try {
      const result = await castVote({
        appId: props.appId,
        questionIndex: currentQ,
        option,
        voterName: props.playerName || "Anonymous",
      } as any);
      const data = (result?.structuredContent as unknown) as {
        success: boolean;
        votes?: Record<string, Record<string, string[]>>;
        message?: string;
      } | undefined;
      if (data?.success && data.votes) {
        setLiveVotes(data.votes);
        const updated = { ...votedQuestions };
        if (!props.multiChoice) {
          updated[String(currentQ)] = [option];
        } else {
          updated[String(currentQ)] = [...(updated[String(currentQ)] ?? []), option];
        }
        setVotedQuestions(updated);
      } else {
        setVoteError(data?.message ?? "Failed to vote");
      }
    } catch {
      setVoteError("Something went wrong");
    }
  };

  const handleNext = async () => {
    await advanceQuestion({ appId: props.appId }).catch(() => {});
  };

  const copyCode = () => {
    navigator.clipboard.writeText(props.appId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const questionData = props.questions[currentQ];
  if (!questionData) return null;

  const qKey = String(currentQ);
  const qVotes = liveVotes[qKey] ?? {};
  const total = totalVotesForQ(qVotes);
  const totalQuestions = props.questions.length;
  const showResults = hasVotedCurrentQ || phase === "results" || phase === "ended";

  // ── ENDED ──
  if (phase === "ended") {
    return (
      <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
        <div className="px-6 pt-6 pb-4 text-center">
          <div className="text-3xl mb-2">📊</div>
          <h2 className="text-2xl font-bold text-default">{props.title}</h2>
          <p className="text-secondary text-sm mt-1">Poll complete — {totalQuestions} question(s)</p>
        </div>
        <div className="px-6 pb-4 space-y-5">
          {props.questions.map((q, qi) => {
            const qv = liveVotes[String(qi)] ?? {};
            const t = totalVotesForQ(qv);
            return (
              <div key={qi} className="bg-default/5 rounded-2xl p-4">
                <p className="text-xs text-secondary mb-1">Q{qi + 1}/{totalQuestions}</p>
                <p className="text-sm font-bold text-default mb-2">{q.question}</p>
                <div className="space-y-1.5">
                  {q.options.map((opt, oi) => {
                    const count = qv[opt]?.length ?? 0;
                    const p = t > 0 ? Math.round((count / t) * 100) : 0;
                    const color = OPTION_COLORS[oi % OPTION_COLORS.length];
                    return (
                      <div key={opt}>
                        <div className="flex justify-between text-xs mb-0.5">
                          <span className="text-default font-medium">{opt}</span>
                          <span className="text-default tabular-nums font-bold">{p}% ({count})</span>
                        </div>
                        <div className="h-6 w-full rounded-lg bg-default/8 overflow-hidden">
                          <div className="h-full rounded-lg transition-all duration-700" style={{ width: `${p}%`, backgroundColor: color.bar, opacity: 0.85 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="px-6 pb-6 border-t border-default pt-4">
          <button
            onClick={() => sendFollowUpMessage(
              `Analyze results for poll "${props.title}". ${props.questions.map((q, qi) => {
                const qv = liveVotes[String(qi)] ?? {};
                return `Q${qi+1}: "${q.question}" — ${Object.entries(qv).map(([o, v]) => `"${o}": ${v.length}`).join(", ")}`;
              }).join(". ")}`
            )}
            className="w-full py-3 rounded-xl bg-info/10 text-info font-medium text-sm hover:bg-info/20 transition-colors cursor-pointer"
          >
            Ask AI to analyze results
          </button>
        </div>
      </div>
    );
  }

  // ── VOTING / RESULTS ──
  return (
    <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
      {totalQuestions > 1 && (
        <div className="h-1.5 w-full bg-default/10">
          <div className="h-full bg-info transition-all duration-500" style={{ width: `${((currentQ + (phase === "results" ? 1 : 0)) / totalQuestions) * 100}%` }} />
        </div>
      )}

      <div className="px-6 pt-5 pb-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-secondary">Live Poll</span>
            {totalQuestions > 1 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-default/10 text-secondary font-medium">{currentQ + 1}/{totalQuestions}</span>
            )}
          </div>
          <button onClick={copyCode} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-default text-xs font-mono font-semibold text-secondary hover:bg-default/5 transition-colors cursor-pointer">
            <span className="text-info">#{props.appId}</span>
            <span>{copied ? "✓ Copied" : "Copy code"}</span>
          </button>
        </div>
        {totalQuestions > 1 && <p className="text-xs text-secondary mb-1 font-medium">{props.title}</p>}
        <h2 className="text-xl font-bold text-default leading-snug">{questionData.question}</h2>
        <p className="text-sm text-secondary mt-1">{total} {total === 1 ? "vote" : "votes"} • updates live</p>
      </div>

      <div className="px-6 pb-2 space-y-3">
        {questionData.options.map((option, i) => {
          const color = OPTION_COLORS[i % OPTION_COLORS.length];
          const count = qVotes[option]?.length ?? 0;
          const percent = pct(qVotes, option);
          const isVoted = currentQVoted.includes(option);

          if (showResults) {
            return (
              <div key={option}>
                <div className="flex justify-between mb-1">
                  <span className="text-sm font-semibold text-default flex items-center gap-1.5">
                    {isVoted && <span className="text-xs px-1.5 py-0.5 rounded-full bg-info/10 text-info">✓</span>}
                    {option}
                  </span>
                  <span className="text-sm font-bold text-default tabular-nums">{percent}% ({count})</span>
                </div>
                <div className="h-10 w-full rounded-xl bg-default/8 overflow-hidden relative">
                  <div className="h-full rounded-xl transition-all duration-700" style={{ width: `${percent}%`, backgroundColor: color.bar, opacity: 0.8 }} />
                  <div className="absolute inset-0 flex items-center px-3">
                    <span className="text-sm font-medium text-default/80 z-10">{option}</span>
                  </div>
                </div>
              </div>
            );
          }

          return (
            <button
              key={option}
              onClick={() => handleVote(option)}
              disabled={isVoting}
              className="w-full h-14 rounded-xl text-white font-bold text-base transition-all active:scale-[0.98] disabled:opacity-60 cursor-pointer"
              style={{ backgroundColor: color.bg }}
            >
              {option}
            </button>
          );
        })}
      </div>

      {voteError && (
        <div className="mx-6 mb-3 px-3 py-2 rounded-xl bg-danger/10 text-danger text-sm">{voteError}</div>
      )}

      <div className="px-6 py-4 border-t border-default">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-secondary">
            Code: <span className="font-mono font-bold text-default">#{props.appId}</span>
          </div>
          {showResults && (
            <button
              onClick={() => sendFollowUpMessage(
                `Analyze the poll results for Q${currentQ + 1}: "${questionData.question}". Votes: ${Object.entries(qVotes).map(([opt, voters]) => `"${opt}": ${voters.length}`).join(", ")}. Total: ${total} votes.`
              )}
              className="text-xs px-3 py-1.5 rounded-full bg-info/10 text-info hover:bg-info/20 transition-colors cursor-pointer font-medium"
            >
              Ask AI to analyze
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Quiz View ─────────────────────────────────────────────────────────────────

function QuizView({ props, sendFollowUpMessage }: { props: Props; sendFollowUpMessage: (msg: string) => void }) {
  const { callToolAsync: getState } = useCallTool("get-app-state");
  const { callToolAsync: submitAnswer, isPending: isSubmitting } = useCallTool("submit-quiz-answer");
  const { callToolAsync: startQuiz, isPending: isStarting } = useCallTool("start-quiz");
  const { callToolAsync: nextQuestion, isPending: isAdvancing } = useCallTool("next-question");

  const [phase, setPhase] = useState(props.quizPhase ?? "lobby");
  const [currentQ, setCurrentQ] = useState(0);
  const [questionStartTime, setQuestionStartTime] = useState<number | null>(props.questionStartTime ?? null);
  const [answers, setAnswers] = useState<Record<string, Record<string, { answerIndex: number; timeMs: number; playerName: string }>>>(props.answers ?? {});
  const [scores, setScores] = useState<Record<string, { name: string; score: number }>>(props.scores ?? {});
  const [players, setPlayers] = useState<Record<string, string>>(props.players ?? {});
  const [timeLeft, setTimeLeft] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [lastPoints, setLastPoints] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const questions = props.quizQuestions;

  // Reset answer state when question changes (for all players, not just host)
  useEffect(() => {
    setSelectedAnswer(null);
    setLastPoints(null);
  }, [currentQ]);

  useEffect(() => {
    const poll = async () => {
      try {
        const result = await getState({ appId: props.appId });
        const data = result?.structuredContent as AppStateResult | undefined;
        if (!data?.found) return;
        if (data.phase !== undefined) setPhase(data.phase);
        if (data.currentQuestion !== undefined) setCurrentQ(data.currentQuestion);
        if (data.questionStartTime !== undefined) setQuestionStartTime(data.questionStartTime ?? null);
        if (data.answers !== undefined) setAnswers(data.answers as any);
        if (data.scores !== undefined) setScores(data.scores);
        if (data.players !== undefined) setPlayers(data.players);
      } catch { /* silent */ }
    };
    poll();
    pollingRef.current = setInterval(poll, 2500);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [props.appId]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (phase !== "question" || !questionStartTime) return;
    const timeLimit = questions?.[currentQ]?.timeLimit ?? 20;
    const update = () => {
      const elapsed = Math.floor((Date.now() - questionStartTime) / 1000);
      setTimeLeft(Math.max(0, timeLimit - elapsed));
    };
    update();
    timerRef.current = setInterval(update, 500);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase, questionStartTime, currentQ]);

  const currentQData = questions?.[currentQ];
  const myAnswerForCurrentQ = answers[String(currentQ)]?.[props.playerId];
  const hasAnsweredCurrentQ = !!myAnswerForCurrentQ || selectedAnswer !== null;
  const playerCount = Object.keys(players).length;
  const answeredCount = Object.keys(answers[String(currentQ)] ?? {}).length;
  const timeLimit = currentQData?.timeLimit ?? 20;
  const timerPct = timeLimit > 0 ? (timeLeft / timeLimit) * 100 : 0;
  const timerColor = timerPct > 50 ? "#22c55e" : timerPct > 25 ? "#f59e0b" : "#ef4444";

  const copyCode = () => {
    navigator.clipboard.writeText(props.appId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmitAnswer = async (answerIndex: number) => {
    if (isSubmitting || hasAnsweredCurrentQ) return;
    setSelectedAnswer(answerIndex);
    try {
      const result = await submitAnswer({
        appId: props.appId,
        playerId: props.playerId,
        playerName: props.playerName,
        questionIndex: currentQ,
        answerIndex,
      });
      const data = result?.structuredContent as { success: boolean; points?: number } | undefined;
      if (data?.success) setLastPoints(data.points ?? 0);
    } catch {
      setSelectedAnswer(null);
    }
  };

  const handleNext = async () => {
    await nextQuestion({ appId: props.appId }).catch(() => {});
    setSelectedAnswer(null);
    setLastPoints(null);
  };

  const sorted = Object.entries(scores).sort(([, a], [, b]) => b.score - a.score);
  const medals = ["🥇", "🥈", "🥉"];

  // LOBBY
  if (phase === "lobby") {
    return (
      <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold uppercase tracking-widest text-secondary">Quiz Lobby</span>
            <button onClick={copyCode} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-default text-xs font-mono font-semibold text-secondary hover:bg-default/5 cursor-pointer">
              <span className="text-info">#{props.appId}</span>
              <span>{copied ? "✓" : "Copy"}</span>
            </button>
          </div>
          <h2 className="text-2xl font-bold text-default">{props.quizTitle}</h2>
          <p className="text-sm text-secondary mt-1">{questions.length} questions</p>
        </div>
        <div className="px-6 pb-4">
          <div className="bg-default/5 rounded-2xl p-4">
            <p className="text-sm font-semibold text-default mb-2">Players ({playerCount})</p>
            {playerCount === 0 ? (
              <p className="text-sm text-secondary">No players yet. Share code <span className="font-mono font-bold text-info">#{props.appId}</span></p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {Object.entries(players).map(([pid, name]) => (
                  <span key={pid} className={`px-3 py-1 rounded-full text-sm font-medium ${pid === props.playerId ? "bg-info/15 text-info" : "bg-default/10 text-default"}`}>
                    {name}{pid === props.playerId ? " (you)" : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="px-6 pb-6">
          {props.isHost ? (
            <button onClick={() => startQuiz({ appId: props.appId })} disabled={isStarting} className="w-full py-4 rounded-2xl bg-info text-white font-bold text-lg hover:opacity-90 cursor-pointer disabled:opacity-60">
              {isStarting ? "Starting..." : "Start Quiz →"}
            </button>
          ) : (
            <div className="text-center py-4 text-secondary text-sm animate-pulse">Waiting for host to start...</div>
          )}
        </div>
      </div>
    );
  }

  // QUESTION
  if (phase === "question" && currentQData) {
    return (
      <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
        <div className="h-2 w-full bg-default/10">
          <div className="h-full transition-all duration-500" style={{ width: `${timerPct}%`, backgroundColor: timerColor }} />
        </div>
        <div className="px-6 pt-4 pb-3">
          <div className="flex justify-between text-sm text-secondary mb-2">
            <span>Q{currentQ + 1}/{questions.length}</span>
            <span className="font-bold tabular-nums text-lg" style={{ color: timerColor }}>{timeLeft}s</span>
          </div>
          <h2 className="text-xl font-bold text-default">{currentQData.question}</h2>
          <p className="text-xs text-secondary mt-1">{answeredCount}/{playerCount} answered</p>
        </div>
        <div className="px-4 pb-4 grid grid-cols-2 gap-3">
          {currentQData.options.map((option, i) => {
            const color = OPTION_COLORS[i % OPTION_COLORS.length];
            const isSelected = selectedAnswer === i;
            const disabled = hasAnsweredCurrentQ || props.isHost || timeLeft === 0;
            return (
              <button
                key={i}
                onClick={() => handleSubmitAnswer(i)}
                disabled={disabled || isSubmitting}
                className="h-20 rounded-2xl text-white font-bold text-sm transition-all active:scale-[0.98] cursor-pointer disabled:cursor-not-allowed overflow-hidden relative"
                style={{ backgroundColor: color.bg, opacity: hasAnsweredCurrentQ && !isSelected ? 0.5 : 1 }}
              >
                <div className="absolute top-2 left-3 text-white/50 text-xl">{color.icon}</div>
                <div className="px-3 pt-5 leading-tight">{option}</div>
                {isSelected && <div className="absolute top-2 right-2 text-white text-xs bg-black/20 rounded-full px-1.5 py-0.5">✓</div>}
              </button>
            );
          })}
        </div>
        {hasAnsweredCurrentQ && !props.isHost && (
          <div className="mx-6 mb-4 px-4 py-3 rounded-xl bg-default/8 text-center">
            <p className="text-sm font-semibold text-default">
              Submitted! {lastPoints !== null && lastPoints > 0 ? `+${lastPoints} pts` : lastPoints === 0 ? "Wrong" : ""}
            </p>
          </div>
        )}
        {props.isHost && (
          <div className="px-6 pb-5">
            <button onClick={handleNext} disabled={isAdvancing} className="w-full py-3 rounded-xl border border-default text-secondary text-sm font-medium hover:bg-default/5 cursor-pointer disabled:opacity-60">
              Show Answer ({answeredCount}/{playerCount})
            </button>
          </div>
        )}
      </div>
    );
  }

  // REVEAL
  if (phase === "reveal" && currentQData) {
    const myAnswer = answers[String(currentQ)]?.[props.playerId];
    const isCorrect = myAnswer?.answerIndex === currentQData.correctIndex;
    return (
      <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
        <div className="px-6 pt-6 pb-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-secondary mb-1">Answer</p>
          <h2 className="text-lg font-bold text-default">{currentQData.question}</h2>
        </div>
        <div className="px-4 pb-4 grid grid-cols-2 gap-3">
          {currentQData.options.map((option, i) => {
            const color = OPTION_COLORS[i % OPTION_COLORS.length];
            const isCorrectOpt = i === currentQData.correctIndex;
            const answererCount = Object.values(answers[String(currentQ)] ?? {}).filter(a => a.answerIndex === i).length;
            return (
              <div key={i} className="h-20 rounded-2xl overflow-hidden relative" style={{ backgroundColor: isCorrectOpt ? color.bg : "#6b7280", opacity: isCorrectOpt ? 1 : 0.4 }}>
                <div className="absolute top-2 left-3 text-white/50 text-xl">{color.icon}</div>
                {isCorrectOpt && <div className="absolute top-2 right-2 text-white">✓</div>}
                <div className="px-3 pt-5 text-white font-bold text-sm leading-tight">{option}</div>
                <div className="absolute bottom-1.5 right-2 text-white/70 text-xs">{answererCount} voted</div>
              </div>
            );
          })}
        </div>
        {!props.isHost && (
          <div className={`mx-6 mb-3 px-4 py-3 rounded-xl text-center ${isCorrect ? "bg-green-500/15 border border-green-500/30" : "bg-red-500/15 border border-red-500/30"}`}>
            <p className={`font-bold ${isCorrect ? "text-green-500" : "text-red-500"}`}>
              {myAnswer ? (isCorrect ? `Correct! +${lastPoints ?? 0} pts` : "Wrong") : "Didn't answer"}
            </p>
            <p className="text-xs text-secondary mt-0.5">Score: {scores[props.playerId]?.score?.toLocaleString() ?? 0} pts</p>
          </div>
        )}
        <div className="px-6 pb-3 space-y-2">
          {sorted.slice(0, 5).map(([pid, entry], i) => (
            <div key={pid} className={`flex items-center gap-2 px-3 py-2 rounded-xl ${pid === props.playerId ? "bg-info/10" : "bg-default/5"}`}>
              <span className="w-6 text-sm">{i < 3 ? medals[i] : `${i + 1}.`}</span>
              <span className="flex-1 text-sm font-medium text-default">{entry.name}</span>
              <span className="font-bold text-default tabular-nums text-sm">{entry.score.toLocaleString()}</span>
            </div>
          ))}
        </div>
        {props.isHost && (
          <div className="px-6 pb-5">
            <button onClick={handleNext} disabled={isAdvancing} className="w-full py-3 rounded-xl bg-info text-white font-bold hover:opacity-90 cursor-pointer disabled:opacity-60">
              {isAdvancing ? "..." : currentQ + 1 < questions.length ? `Next (${currentQ + 2}/${questions.length}) →` : "Finish →"}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ENDED
  const winner = sorted[0];
  const myRank = sorted.findIndex(([pid]) => pid === props.playerId) + 1;
  return (
    <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
      <div className="px-6 pt-6 pb-4 text-center">
        <div className="text-4xl mb-2">🏆</div>
        <h2 className="text-2xl font-bold text-default">{props.quizTitle}</h2>
        <p className="text-secondary text-sm mt-1">Final Results</p>
        {winner && <p className="text-base font-semibold text-info mt-1">{winner[1].name} wins with {winner[1].score.toLocaleString()} pts!</p>}
        {myRank > 0 && <p className="text-sm text-secondary mt-0.5">You: #{myRank} • {scores[props.playerId]?.score?.toLocaleString() ?? 0} pts</p>}
      </div>
      <div className="px-6 pb-3 space-y-2">
        {sorted.map(([pid, entry], i) => (
          <div key={pid} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl ${pid === props.playerId ? "bg-info/10 border border-info/20" : "bg-default/5"}`}>
            <span className="w-8 text-base">{i < 3 ? medals[i] : `${i + 1}.`}</span>
            <span className="flex-1 text-sm font-semibold text-default">{entry.name}{pid === props.playerId ? " (you)" : ""}</span>
            <span className="font-bold text-default tabular-nums">{entry.score.toLocaleString()}</span>
          </div>
        ))}
      </div>
      <div className="px-6 pb-6 border-t border-default pt-4">
        <button
          onClick={() => sendFollowUpMessage(`The quiz "${props.quizTitle}" just ended! Final scores: ${sorted.map(([, e], i) => `#${i + 1} ${e.name}: ${e.score} pts`).join(", ")}. Congratulate the winner!`)}
          className="w-full py-3 rounded-xl bg-info/10 text-info font-medium text-sm hover:bg-info/20 cursor-pointer"
        >
          Ask AI to announce the winner 🎉
        </button>
      </div>
    </div>
  );
}

// ─── Main widget ───────────────────────────────────────────────────────────────

export default function AppViewer() {
  const { props, isPending, state, setState, sendFollowUpMessage } = useWidget<Props, AppViewerState>();

  if (isPending) {
    return (
      <McpUseProvider autoSize>
        <div className="p-6 bg-surface-elevated border border-default rounded-3xl">
          <div className="animate-pulse space-y-3">
            <div className="h-5 w-24 bg-default/10 rounded-full" />
            <div className="h-7 w-3/4 bg-default/10 rounded-lg" />
            <div className="space-y-2 mt-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-default/10 rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </McpUseProvider>
    );
  }

  // Show name entry before the game
  if (!state?.confirmedName) {
    return (
      <McpUseProvider autoSize>
        <NameEntry
          defaultName={props.playerName}
          appType={props.appType}
          title={props.appType === "poll" ? props.title : props.quizTitle}
          appId={props.appId}
          onConfirm={(name) => setState({ confirmedName: name })}
        />
      </McpUseProvider>
    );
  }

  // Override playerName with the user-entered name
  const gameProps = { ...props, playerName: state.confirmedName };

  return (
    <McpUseProvider autoSize>
      {props.appType === "poll" ? (
        <PollView props={gameProps} sendFollowUpMessage={sendFollowUpMessage} />
      ) : (
        <QuizView props={gameProps} sendFollowUpMessage={sendFollowUpMessage} />
      )}
    </McpUseProvider>
  );
}
