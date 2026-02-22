import {
  McpUseProvider,
  useCallTool,
  useWidget,
  type WidgetMetadata,
} from "mcp-use/react";
import { z } from "zod";
import React, { useEffect, useState } from "react";
import "../styles.css";

const pollQuestionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
});

const propsSchema = z.object({
  appId: z.string(),
  appType: z.literal("poll"),
  title: z.string(),
  questions: z.array(pollQuestionSchema),
  multiChoice: z.boolean(),
  currentQuestion: z.number(),
  phase: z.string(),
  votes: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
  isHost: z.boolean(),
  voterId: z.string(),
  voterName: z.string(),
});

export const widgetMetadata: WidgetMetadata = {
  description: "Live multiplayer poll with multiple questions and real-time vote tracking",
  props: propsSchema,
  exposeAsTool: false,
  metadata: {
    invoking: "Creating poll...",
    invoked: "Poll is live!",
  },
};

type Props = z.infer<typeof propsSchema>;

type StateShape = { votedQuestions: Record<string, string[]> };

type AppStateResult = {
  found: boolean;
  currentQuestion?: number;
  phase?: string;
  votes?: Record<string, Record<string, string[]>>;
};

const OPTION_COLORS = [
  { bg: "bg-red-500", hover: "hover:bg-red-600", bar: "#ef4444" },
  { bg: "bg-blue-500", hover: "hover:bg-blue-600", bar: "#3b82f6" },
  { bg: "bg-yellow-400", hover: "hover:bg-yellow-500", bar: "#facc15" },
  { bg: "bg-green-500", hover: "hover:bg-green-600", bar: "#22c55e" },
  { bg: "bg-purple-500", hover: "hover:bg-purple-600", bar: "#a855f7" },
  { bg: "bg-orange-500", hover: "hover:bg-orange-600", bar: "#f97316" },
];

function totalVotesForQ(votes: Record<string, string[]>): number {
  return Object.values(votes).flat().length;
}

function pct(qVotes: Record<string, string[]>, option: string): number {
  const total = totalVotesForQ(qVotes);
  if (total === 0) return 0;
  return Math.round(((qVotes[option]?.length ?? 0) / total) * 100);
}

export default function PollWidget() {
  const { props, isPending, state, setState, sendFollowUpMessage } =
    useWidget<Props, StateShape>();

  const { callToolAsync: getState } = useCallTool("get-app-state");
  const { callToolAsync: castVote, isPending: isVoting } = useCallTool("cast-vote");
  const { callToolAsync: advanceQuestion, isPending: isAdvancing } = useCallTool("next-question");

  const [currentQ, setCurrentQ] = useState(0);
  const [phase, setPhase] = useState("voting");
  const [liveVotes, setLiveVotes] = useState<Record<string, Record<string, string[]>>>({});
  const [copied, setCopied] = useState(false);
  const [voteError, setVoteError] = useState("");

  const votedQuestions: Record<string, string[]> = state?.votedQuestions ?? {};
  const currentQVoted = votedQuestions[String(currentQ)] ?? [];
  const hasVotedCurrentQ = currentQVoted.length > 0;

  // Clear vote error when question changes
  useEffect(() => {
    setVoteError("");
  }, [currentQ]);

  // Initialize from props
  useEffect(() => {
    if (!isPending) {
      setCurrentQ(props.currentQuestion);
      setPhase(props.phase);
      setLiveVotes(props.votes);
    }
  }, [isPending]);

  // Poll for live updates
  useEffect(() => {
    if (isPending) return;

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
  }, [isPending, props.appId]);

  const handleVote = async (option: string) => {
    if (isVoting) return;
    setVoteError("");

    try {
      const result = await castVote({
        appId: props.appId ?? "",
        questionIndex: currentQ,
        option,
        voterName: props.voterName || "Anonymous",
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
        setState({ votedQuestions: updated });
      } else {
        setVoteError(data?.message ?? "Failed to vote");
      }
    } catch {
      setVoteError("Something went wrong");
    }
  };

  const handleNext = async () => {
    try {
      const result = await advanceQuestion({ appId: props.appId ?? "" });
      const data = result?.structuredContent as { success?: boolean; phase?: string; currentQuestion?: number } | undefined;
      if (data?.success) {
        if (data.phase) setPhase(data.phase);
        if (data.currentQuestion !== undefined) setCurrentQ(data.currentQuestion);
      }
    } catch { /* silent */ }
  };

  const copyCode = () => {
    navigator.clipboard.writeText(props.appId ?? "").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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

  const questionData = props.questions[currentQ];
  if (!questionData) return null;

  const qKey = String(currentQ);
  const qVotes = liveVotes[qKey] ?? {};
  const total = totalVotesForQ(qVotes);
  const showResults = hasVotedCurrentQ || props.isHost || phase === "results" || phase === "ended";
  const totalQuestions = props.questions.length;

  // ── ENDED ──
  if (phase === "ended") {
    return (
      <McpUseProvider autoSize>
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
      </McpUseProvider>
    );
  }

  // ── VOTING / RESULTS ──
  return (
    <McpUseProvider autoSize>
      <div className="bg-surface-elevated border border-default rounded-3xl overflow-hidden">
        {/* Progress bar */}
        {totalQuestions > 1 && (
          <div className="h-1.5 w-full bg-default/10">
            <div
              className="h-full bg-info transition-all duration-500"
              style={{ width: `${((currentQ + (phase === "results" ? 1 : 0)) / totalQuestions) * 100}%` }}
            />
          </div>
        )}

        {/* Header */}
        <div className="px-6 pt-5 pb-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-widest text-secondary">
                Live Poll
              </span>
              {totalQuestions > 1 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-default/10 text-secondary font-medium">
                  {currentQ + 1}/{totalQuestions}
                </span>
              )}
            </div>
            <button
              onClick={copyCode}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-default text-xs font-mono font-semibold text-secondary hover:bg-default/5 transition-colors cursor-pointer"
            >
              <span className="text-info">#{props.appId}</span>
              <span>{copied ? "✓ Copied" : "Copy code"}</span>
            </button>
          </div>
          {totalQuestions > 1 && (
            <p className="text-xs text-secondary mb-1 font-medium">{props.title}</p>
          )}
          <h2 className="text-xl font-bold text-default leading-snug">
            {questionData.question}
          </h2>
          <p className="text-sm text-secondary mt-1">
            {total} {total === 1 ? "vote" : "votes"} so far • updates live
          </p>
        </div>

        {/* Options */}
        <div className="px-6 pb-2 space-y-3">
          {questionData.options.map((option, i) => {
            const color = OPTION_COLORS[i % OPTION_COLORS.length];
            const count = qVotes[option]?.length ?? 0;
            const percent = pct(qVotes, option);
            const isVoted = currentQVoted.includes(option);

            if (showResults) {
              return (
                <div key={option} className="relative">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-default flex items-center gap-1.5">
                      {isVoted && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-info/10 text-info">
                          ✓
                        </span>
                      )}
                      {option}
                    </span>
                    <span className="text-sm font-bold text-default tabular-nums">
                      {percent}% ({count})
                    </span>
                  </div>
                  <div className="h-10 w-full rounded-xl bg-default/8 overflow-hidden relative">
                    <div
                      className="h-full rounded-xl transition-all duration-700"
                      style={{ width: `${percent}%`, backgroundColor: color.bar, opacity: 0.85 }}
                    />
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
                className={`w-full h-14 rounded-xl text-white font-bold text-base transition-all duration-150 active:scale-[0.98] disabled:opacity-60 cursor-pointer ${color.bg} ${color.hover}`}
              >
                {option}
              </button>
            );
          })}
        </div>

        {voteError && (
          <div className="mx-6 mb-3 px-3 py-2 rounded-xl bg-danger/10 text-danger text-sm">
            {voteError}
          </div>
        )}

        {/* Footer / Host controls */}
        <div className="px-6 py-4 border-t border-default">
          {props.isHost && phase === "voting" && (
            <button
              onClick={handleNext}
              disabled={isAdvancing}
              className="w-full py-3 rounded-xl border border-default text-secondary text-sm font-medium hover:bg-default/5 cursor-pointer disabled:opacity-60 mb-3"
            >
              {isAdvancing ? "..." : `Show Results (${total} votes)`}
            </button>
          )}
          {props.isHost && phase === "results" && (
            <button
              onClick={handleNext}
              disabled={isAdvancing}
              className="w-full py-3 rounded-xl bg-info text-white font-bold text-sm hover:opacity-90 cursor-pointer disabled:opacity-60 mb-3"
            >
              {isAdvancing ? "..." : currentQ + 1 < totalQuestions ? `Next Question (${currentQ + 2}/${totalQuestions}) →` : "Finish Poll →"}
            </button>
          )}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-secondary">
              Share code <span className="font-mono font-bold text-default">#{props.appId}</span> to invite others
            </div>
            {showResults && (
              <button
                onClick={() =>
                  sendFollowUpMessage(
                    `Analyze the poll results for Q${currentQ + 1}: "${questionData.question}". Votes: ${Object.entries(qVotes)
                      .map(([opt, voters]) => `"${opt}": ${voters.length}`)
                      .join(", ")}. Total votes: ${total}.`
                  )
                }
                className="text-xs px-3 py-1.5 rounded-full bg-info/10 text-info hover:bg-info/20 transition-colors cursor-pointer font-medium"
              >
                Ask AI to analyze results
              </button>
            )}
          </div>
        </div>
      </div>
    </McpUseProvider>
  );
}
