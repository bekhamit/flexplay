import {
  McpUseProvider,
  useCallTool,
  useWidget,
  type WidgetMetadata,
} from "mcp-use/react";
import { z } from "zod";
import React, { useEffect, useRef, useState } from "react";
import "../styles.css";

const questionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  correctIndex: z.number(),
  timeLimit: z.number(),
});

const answerSchema = z.object({
  answerIndex: z.number(),
  timeMs: z.number(),
  playerName: z.string(),
});

const scoreSchema = z.object({ name: z.string(), score: z.number() });

const propsSchema = z.object({
  appId: z.string(),
  appType: z.literal("quiz"),
  title: z.string(),
  questions: z.array(questionSchema),
  phase: z.string(),
  currentQuestion: z.number(),
  questionStartTime: z.number().nullable(),
  answers: z.record(z.string(), z.record(z.string(), answerSchema)),
  scores: z.record(z.string(), scoreSchema),
  players: z.record(z.string(), z.string()),
  playerId: z.string(),
  playerName: z.string(),
  isHost: z.boolean(),
});

export const widgetMetadata: WidgetMetadata = {
  description: "Kahoot-style multiplayer quiz with live scoring and leaderboard",
  props: propsSchema,
  exposeAsTool: false,
  metadata: {
    invoking: "Setting up quiz...",
    invoked: "Quiz is ready!",
  },
};

type Props = z.infer<typeof propsSchema>;

type AppStateResult = {
  found: boolean;
  phase?: string;
  currentQuestion?: number;
  questionStartTime?: number | null;
  answers?: Record<string, Record<string, { answerIndex: number; timeMs: number; playerName: string }>>;
  scores?: Record<string, { name: string; score: number }>;
  players?: Record<string, string>;
};

const ANSWER_COLORS = [
  { bg: "#e74c3c", hover: "#c0392b", icon: "▲", label: "Red" },
  { bg: "#3498db", hover: "#2980b9", icon: "◆", label: "Blue" },
  { bg: "#f39c12", hover: "#d68910", icon: "●", label: "Yellow" },
  { bg: "#27ae60", hover: "#219a52", icon: "■", label: "Green" },
];

function Leaderboard({
  scores,
  title = "Leaderboard",
  myPlayerId,
}: {
  scores: Record<string, { name: string; score: number }>;
  title?: string;
  myPlayerId: string;
}) {
  const sorted = Object.entries(scores)
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, 10);

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className="space-y-2">
      <h3 className="text-base font-bold text-default mb-3">{title}</h3>
      {sorted.length === 0 ? (
        <p className="text-sm text-secondary">No scores yet</p>
      ) : (
        sorted.map(([pid, entry], i) => {
          const isMe = pid === myPlayerId;
          return (
            <div
              key={pid}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
                isMe
                  ? "bg-info/15 border border-info/30"
                  : "bg-default/5 border border-transparent"
              }`}
            >
              <span className="text-lg w-8 text-center">
                {i < 3 ? medals[i] : `${i + 1}.`}
              </span>
              <span className="flex-1 font-semibold text-default text-sm">
                {entry.name}
                {isMe && (
                  <span className="ml-2 text-xs text-info font-normal">(you)</span>
                )}
              </span>
              <span className="font-bold text-default tabular-nums">
                {entry.score.toLocaleString()} pts
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

export default function QuizWidget() {
  const { props, isPending, sendFollowUpMessage } = useWidget<Props>();

  const { callToolAsync: getState } = useCallTool("get-app-state");
  const { callToolAsync: submitAnswer, isPending: isSubmitting } =
    useCallTool("submit-quiz-answer");
  const { callToolAsync: startQuiz, isPending: isStarting } =
    useCallTool("start-quiz");
  const { callToolAsync: nextQuestion, isPending: isAdvancing } =
    useCallTool("next-question");

  const [phase, setPhase] = useState(props.phase ?? "lobby");
  const [currentQ, setCurrentQ] = useState(props.currentQuestion ?? 0);
  const [questionStartTime, setQuestionStartTime] = useState<number | null>(
    props.questionStartTime ?? null
  );
  const [answers, setAnswers] = useState<Record<string, Record<string, { answerIndex: number; timeMs: number; playerName: string }>>>(props.answers ?? {});
  const [scores, setScores] = useState<Record<string, { name: string; score: number }>>(props.scores ?? {});
  const [players, setPlayers] = useState<Record<string, string>>(props.players ?? {});
  const [timeLeft, setTimeLeft] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [lastPoints, setLastPoints] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionMsg, setActionMsg] = useState("");

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync initial state from props when they arrive
  useEffect(() => {
    if (!isPending) {
      setPhase(props.phase ?? "lobby");
      setCurrentQ(props.currentQuestion ?? 0);
      setQuestionStartTime(props.questionStartTime ?? null);
      setAnswers(props.answers ?? {});
      setScores(props.scores ?? {});
      setPlayers(props.players ?? {});
    }
  }, [isPending]);

  // Poll for live state
  useEffect(() => {
    if (isPending) return;

    const poll = async () => {
      try {
        const result = await getState({ appId: props.appId });
        const data = result?.structuredContent as AppStateResult | undefined;
        if (!data?.found) return;

        if (data.phase !== undefined) setPhase(data.phase);
        if (data.currentQuestion !== undefined) setCurrentQ(data.currentQuestion);
        if (data.questionStartTime !== undefined) setQuestionStartTime(data.questionStartTime ?? null);
        if (data.answers !== undefined) setAnswers(data.answers);
        if (data.scores !== undefined) setScores(data.scores);
        if (data.players !== undefined) setPlayers(data.players);
      } catch {
        // silent
      }
    };

    poll();
    pollingRef.current = setInterval(poll, 2500);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [isPending, props.appId]);

  // Countdown timer
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (phase !== "question" || !questionStartTime) return;

    const currentQData = props.questions?.[currentQ];
    const timeLimit = currentQData?.timeLimit ?? 20;

    const update = () => {
      const elapsed = Math.floor((Date.now() - questionStartTime) / 1000);
      setTimeLeft(Math.max(0, timeLimit - elapsed));
    };
    update();
    timerRef.current = setInterval(update, 500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase, questionStartTime, currentQ]);

  if (isPending) {
    return (
      <McpUseProvider autoSize>
        <div className="p-6 bg-surface-elevated border border-default rounded-3xl">
          <div className="animate-pulse space-y-3">
            <div className="h-5 w-24 bg-default/10 rounded-full" />
            <div className="h-8 w-2/3 bg-default/10 rounded-lg" />
            <div className="space-y-2 mt-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-14 bg-default/10 rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </McpUseProvider>
    );
  }

  const currentQData = props.questions?.[currentQ];
  const myAnswerForCurrentQ = answers[String(currentQ)]?.[props.playerId];
  const hasAnsweredCurrentQ = !!myAnswerForCurrentQ || selectedAnswer !== null;
  const playerCount = Object.keys(players).length;
  const answeredCount = Object.keys(answers[String(currentQ)] ?? {}).length;

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
      const data = result?.structuredContent as {
        success: boolean;
        points?: number;
        isCorrect?: boolean;
      } | undefined;
      if (data?.success) {
        setLastPoints(data.points ?? 0);
      }
    } catch {
      setSelectedAnswer(null);
    }
  };

  const handleStart = async () => {
    try {
      const result = await startQuiz({ appId: props.appId });
      const data = result?.structuredContent as { success: boolean; message?: string } | undefined;
      if (!data?.success) setActionMsg(data?.message ?? "Failed to start");
    } catch {
      setActionMsg("Error starting quiz");
    }
  };

  const handleNext = async () => {
    try {
      await nextQuestion({ appId: props.appId });
      setSelectedAnswer(null);
      setLastPoints(null);
      setActionMsg("");
    } catch {
      setActionMsg("Error advancing");
    }
  };

  const timeLimit = currentQData?.timeLimit ?? 20;
  const timerPct = timeLimit > 0 ? (timeLeft / timeLimit) * 100 : 0;
  const timerColor = timerPct > 50 ? "#22c55e" : timerPct > 25 ? "#f59e0b" : "#ef4444";

  // ── LOBBY ──────────────────────────────────────────────────────────────────
  if (phase === "lobby") {
    return (
      <McpUseProvider autoSize>
        <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold uppercase tracking-widest text-secondary">
                Quiz Lobby
              </span>
              <button
                onClick={copyCode}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-default text-xs font-mono font-semibold text-secondary hover:bg-default/5 transition-colors cursor-pointer"
              >
                <span className="text-info">#{props.appId}</span>
                <span>{copied ? "✓ Copied" : "Copy code"}</span>
              </button>
            </div>
            <h2 className="text-2xl font-bold text-default">{props.title}</h2>
            <p className="text-sm text-secondary mt-1">
              {props.questions.length} question{props.questions.length !== 1 ? "s" : ""}
            </p>
          </div>

          <div className="px-6 pb-4">
            <div className="bg-default/5 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-default">
                  Players waiting ({playerCount})
                </span>
                <span className="text-xs text-secondary animate-pulse">
                  • Live
                </span>
              </div>
              {playerCount === 0 ? (
                <p className="text-sm text-secondary">
                  No players yet. Share code{" "}
                  <span className="font-mono font-bold text-info">#{props.appId}</span> to invite!
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(players).map(([pid, name]) => (
                    <span
                      key={pid}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium ${
                        pid === props.playerId
                          ? "bg-info/15 text-info border border-info/30"
                          : "bg-default/10 text-default"
                      }`}
                    >
                      {name}
                      {pid === props.playerId ? " (you)" : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="px-6 pb-6 space-y-3">
            {props.isHost ? (
              <button
                onClick={handleStart}
                disabled={isStarting}
                className="w-full py-4 rounded-2xl bg-info text-white font-bold text-lg transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-60 cursor-pointer"
              >
                {isStarting ? "Starting..." : "Start Quiz →"}
              </button>
            ) : (
              <div className="text-center py-4 text-secondary text-sm">
                Waiting for host to start the quiz...
              </div>
            )}
            {actionMsg && (
              <p className="text-sm text-danger text-center">{actionMsg}</p>
            )}
          </div>
        </div>
      </McpUseProvider>
    );
  }

  // ── QUESTION ───────────────────────────────────────────────────────────────
  if (phase === "question" && currentQData) {
    return (
      <McpUseProvider autoSize>
        <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
          {/* Timer bar */}
          <div className="h-2 w-full bg-default/10">
            <div
              className="h-full transition-all duration-500"
              style={{ width: `${timerPct}%`, backgroundColor: timerColor }}
            />
          </div>

          <div className="px-6 pt-4 pb-2">
            <div className="flex items-center justify-between text-sm text-secondary mb-3">
              <span>
                Q{currentQ + 1} / {props.questions.length}
              </span>
              <span
                className="font-bold tabular-nums text-lg"
                style={{ color: timerColor }}
              >
                {timeLeft}s
              </span>
            </div>
            <h2 className="text-xl font-bold text-default leading-snug">
              {currentQData.question}
            </h2>
            {!props.isHost && (
              <p className="text-xs text-secondary mt-1">
                {answeredCount} of {playerCount} answered
              </p>
            )}
          </div>

          {/* Answer buttons */}
          <div className="px-4 pb-4 grid grid-cols-2 gap-3">
            {currentQData.options.map((option, i) => {
              const color = ANSWER_COLORS[i % ANSWER_COLORS.length];
              const isSelected = selectedAnswer === i;
              const isDisabled = hasAnsweredCurrentQ || props.isHost || timeLeft === 0;

              return (
                <button
                  key={i}
                  onClick={() => handleSubmitAnswer(i)}
                  disabled={isDisabled || isSubmitting}
                  className="relative h-20 rounded-2xl text-white font-bold text-base transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed cursor-pointer overflow-hidden"
                  style={{
                    backgroundColor: isSelected ? color.hover : color.bg,
                    opacity: hasAnsweredCurrentQ && !isSelected ? 0.5 : 1,
                  }}
                >
                  <div className="absolute top-2 left-3 text-white/60 text-xl">
                    {color.icon}
                  </div>
                  <div className="px-3 pt-4 text-sm leading-tight">{option}</div>
                  {isSelected && (
                    <div className="absolute top-2 right-2 text-white text-xs font-medium bg-black/20 rounded-full px-2 py-0.5">
                      ✓
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {hasAnsweredCurrentQ && !props.isHost && (
            <div className="mx-6 mb-4 px-4 py-3 rounded-xl bg-default/8 text-center">
              <p className="text-sm font-semibold text-default">
                Answer submitted!{" "}
                {lastPoints !== null && lastPoints > 0
                  ? `+${lastPoints} pts`
                  : lastPoints === 0
                  ? "Wrong answer"
                  : ""}
              </p>
              <p className="text-xs text-secondary mt-0.5">
                Waiting for others...
              </p>
            </div>
          )}

          {props.isHost && (
            <div className="px-6 pb-5">
              <button
                onClick={handleNext}
                disabled={isAdvancing}
                className="w-full py-3 rounded-xl border border-default text-secondary text-sm font-medium hover:bg-default/5 transition-colors cursor-pointer disabled:opacity-60"
              >
                {isAdvancing ? "..." : `Show Answer (${answeredCount}/${playerCount} answered)`}
              </button>
            </div>
          )}
        </div>
      </McpUseProvider>
    );
  }

  // ── REVEAL ─────────────────────────────────────────────────────────────────
  if (phase === "reveal" && currentQData) {
    const myAnswer = answers[String(currentQ)]?.[props.playerId];
    const isCorrect = myAnswer?.answerIndex === currentQData.correctIndex;

    return (
      <McpUseProvider autoSize>
        <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <p className="text-xs font-semibold uppercase tracking-widest text-secondary mb-2">
              Q{currentQ + 1} Answer
            </p>
            <h2 className="text-xl font-bold text-default leading-snug mb-4">
              {currentQData.question}
            </h2>
          </div>

          <div className="px-4 pb-4 grid grid-cols-2 gap-3">
            {currentQData.options.map((option, i) => {
              const color = ANSWER_COLORS[i % ANSWER_COLORS.length];
              const isCorrectOpt = i === currentQData.correctIndex;
              const myAns = myAnswer?.answerIndex === i;
              const answererCount = Object.values(answers[String(currentQ)] ?? {}).filter(
                (a) => a.answerIndex === i
              ).length;

              return (
                <div
                  key={i}
                  className="relative h-20 rounded-2xl overflow-hidden"
                  style={{
                    backgroundColor: isCorrectOpt ? color.bg : "#6b7280",
                    opacity: isCorrectOpt ? 1 : 0.45,
                  }}
                >
                  <div className="absolute top-2 left-3 text-white/60 text-xl">
                    {color.icon}
                  </div>
                  {isCorrectOpt && (
                    <div className="absolute top-2 right-2 text-white text-base">✓</div>
                  )}
                  <div className="px-3 pt-4 text-white font-bold text-sm leading-tight">
                    {option}
                  </div>
                  <div className="absolute bottom-1.5 right-2 text-white/70 text-xs">
                    {answererCount} voted
                    {myAns ? " (you)" : ""}
                  </div>
                </div>
              );
            })}
          </div>

          {!props.isHost && (
            <div
              className={`mx-6 mb-4 px-4 py-3 rounded-xl text-center ${
                isCorrect ? "bg-green-500/15 border border-green-500/30" : "bg-red-500/15 border border-red-500/30"
              }`}
            >
              <p className={`font-bold text-base ${isCorrect ? "text-green-500" : "text-red-500"}`}>
                {myAnswer
                  ? isCorrect
                    ? `Correct! +${lastPoints ?? 0} pts`
                    : "Wrong answer"
                  : "You didn't answer"}
              </p>
              <p className="text-xs text-secondary mt-0.5">
                Your score: {scores[props.playerId]?.score?.toLocaleString() ?? 0} pts
              </p>
            </div>
          )}

          {/* Mini leaderboard */}
          <div className="px-6 pb-4">
            <Leaderboard
              scores={scores}
              title="Current Standings"
              myPlayerId={props.playerId}
            />
          </div>

          {props.isHost && (
            <div className="px-6 pb-5">
              <button
                onClick={handleNext}
                disabled={isAdvancing}
                className="w-full py-3 rounded-xl bg-info text-white font-bold text-base hover:opacity-90 transition-colors cursor-pointer disabled:opacity-60"
              >
                {isAdvancing
                  ? "..."
                  : currentQ + 1 < props.questions.length
                  ? `Next Question (${currentQ + 2}/${props.questions.length}) →`
                  : "Finish Quiz →"}
              </button>
            </div>
          )}
        </div>
      </McpUseProvider>
    );
  }

  // ── ENDED ──────────────────────────────────────────────────────────────────
  if (phase === "ended" || phase === "scores") {
    const sorted = Object.entries(scores).sort(([, a], [, b]) => b.score - a.score);
    const winner = sorted[0];
    const myRank = sorted.findIndex(([pid]) => pid === props.playerId) + 1;

    return (
      <McpUseProvider autoSize>
        <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
          <div className="px-6 pt-6 pb-4 text-center">
            <div className="text-4xl mb-2">🏆</div>
            <h2 className="text-2xl font-bold text-default">{props.title}</h2>
            <p className="text-secondary text-sm mt-1">Final Results</p>
            {winner && (
              <p className="text-base font-semibold text-info mt-2">
                {winner[1].name} wins with {winner[1].score.toLocaleString()} pts!
              </p>
            )}
            {myRank > 0 && (
              <p className="text-sm text-secondary mt-1">
                You finished #{myRank} with{" "}
                {scores[props.playerId]?.score?.toLocaleString() ?? 0} pts
              </p>
            )}
          </div>

          <div className="px-6 pb-4">
            <Leaderboard
              scores={scores}
              title="Final Leaderboard"
              myPlayerId={props.playerId}
            />
          </div>

          <div className="px-6 pb-6 border-t border-default pt-4">
            <button
              onClick={() =>
                sendFollowUpMessage(
                  `The quiz "${props.title}" just ended. Final scores: ${sorted
                    .map(([, e], i) => `#${i + 1} ${e.name}: ${e.score} pts`)
                    .join(", ")}. Congratulate the winner and summarize the results!`
                )
              }
              className="w-full py-3 rounded-xl bg-info/10 text-info font-medium text-sm hover:bg-info/20 transition-colors cursor-pointer"
            >
              Ask AI to announce the winner 🎉
            </button>
          </div>
        </div>
      </McpUseProvider>
    );
  }

  // Fallback
  return (
    <McpUseProvider autoSize>
      <div className="p-6 text-secondary text-sm">
        Loading quiz state...
      </div>
    </McpUseProvider>
  );
}
