import { MCPServer, object, text, widget } from "mcp-use/server";
import { z } from "zod";
import { randomUUID } from "crypto";

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    // People often copy the MCP endpoint URL which ends in `/mcp`.
    // `baseUrl` should be the server base (origin + optional path prefix),
    // otherwise widget asset URLs become `/mcp/mcp-use/...` and won't load.
    parsed.pathname = parsed.pathname.replace(/\/mcp\/?$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  }
}

const baseUrl = normalizeBaseUrl(process.env.MCP_URL || "http://localhost:3000");

const server = new MCPServer({
  name: "flexplay",
  title: "FlexPlay",
  version: "1.0.0",
  description:
    "Create live multiplayer polls and quizzes. Share a 6-character code so anyone can join and play together in real-time. Works with any AI assistant (ChatGPT, Claude, etc).",
  baseUrl,
  favicon: "favicon.ico",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
});

// ─── Types ────────────────────────────────────────────────────────────────────

type PollQuestion = {
  question: string;
  options: string[];
};

type QuizQuestion = {
  question: string;
  options: string[];
  correctIndex: number;
  timeLimit: number;
};

type PlayerAnswer = {
  answerIndex: number;
  timeMs: number;
  playerName: string;
};

type ScoreEntry = { name: string; score: number };

// answers: questionIndex (as string) -> playerId -> answer
type AnswersMap = Record<string, Record<string, PlayerAnswer>>;
type ScoreMap = Record<string, ScoreEntry>;
type PlayerMap = Record<string, string>;
// Per-question votes: questionIndex (as string) -> option -> voterNames[]
type PollVotesMap = Record<string, Record<string, string[]>>;

type EventEntry = { type: string; data: unknown; timestamp: number };

type PollPhase = "voting" | "results" | "ended";

type PollApp = {
  appId: string;
  appType: "poll";
  spec: { title: string; questions: PollQuestion[]; multiChoice: boolean };
  state: {
    currentQuestion: number;
    phase: PollPhase;
    votes: PollVotesMap;
    hostId: string;
  };
  events: EventEntry[];
  createdAt: number;
};

type QuizPhase = "lobby" | "question" | "reveal" | "scores" | "ended";

type QuizApp = {
  appId: string;
  appType: "quiz";
  spec: { title: string; questions: QuizQuestion[] };
  state: {
    phase: QuizPhase;
    currentQuestion: number;
    questionStartTime: number | null;
    answers: AnswersMap;
    scores: ScoreMap;
    players: PlayerMap;
    hostId: string;
  };
  events: EventEntry[];
  createdAt: number;
};

type App = PollApp | QuizApp;

// ─── Store ────────────────────────────────────────────────────────────────────

const apps = new Map<string, App>();

function generateAppId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

function addEvent(app: App, type: string, data: unknown): void {
  app.events.push({ type, data, timestamp: Date.now() });
}

// ─── Tool: create-poll ────────────────────────────────────────────────────────

server.tool(
  {
    name: "create-poll",
    description:
      "Create a live multiplayer poll with one or many questions. Generate multiple questions at once (e.g. 'make a 10-question poll about YCombinator'). Share the code so others can join and vote on each question live.",
    schema: z.object({
      title: z.string().describe("Poll title (e.g. 'YCombinator Trivia')"),
      questions: z
        .array(
          z.object({
            question: z.string().describe("The poll question"),
            options: z
              .preprocess(
                (val) => typeof val === "string" ? val.split(",").map((s) => s.trim()) : val,
                z.array(z.string()).min(2).max(6)
              )
              .describe("Answer options (2–6 choices), as an array or comma-separated string"),
          })
        )
        .min(1)
        .max(20)
        .describe("Poll questions (1–20). Each has a question and options."),
      multiChoice: z
        .boolean()
        .optional()
        .describe("Allow selecting multiple options per question (default: false)"),
    }),
    widget: {
      name: "poll-widget",
      invoking: "Creating your poll...",
      invoked: "Poll is live!",
    },
  },
  async ({ title, questions, multiChoice = false }) => {
    const appId = generateAppId();
    const hostId = "host_" + randomUUID().slice(0, 6);

    // Initialize per-question votes
    const votes: PollVotesMap = {};
    for (let i = 0; i < questions.length; i++) {
      votes[String(i)] = {};
      for (const opt of questions[i].options) votes[String(i)][opt] = [];
    }

    const app: PollApp = {
      appId,
      appType: "poll",
      spec: { title, questions, multiChoice },
      state: { currentQuestion: 0, phase: "voting", votes, hostId },
      events: [],
      createdAt: Date.now(),
    };
    apps.set(appId, app);
    addEvent(app, "created", { title, questionCount: questions.length });

    return widget({
      props: {
        appId,
        appType: "poll" as const,
        title,
        questions,
        multiChoice,
        currentQuestion: 0,
        phase: "voting",
        votes,
        isHost: true,
        voterId: hostId,
        voterName: "Host",
      },
      output: text(
        [
          `Poll "${title}" created with ${questions.length} question(s)!`,
          `Share code: **${appId}**`,
          ``,
          `Others can join by saying: "Join game ${appId} as [their name]"`,
          ``,
          `--- Current Question (1/${questions.length}) ---`,
          `${questions[0].question}`,
          ...questions[0].options.map((opt, i) => `  ${i + 1}. ${opt}`),
          ``,
          `You are the host. Use "next-question" to advance after voting.`,
          questions.length > 1
            ? `All questions: ${questions.map((q, i) => `\nQ${i + 1}: ${q.question} (${q.options.join(", ")})`).join("")}`
            : "",
        ].filter(Boolean).join("\n")
      ),
    });
  }
);

// ─── Tool: create-quiz ────────────────────────────────────────────────────────

server.tool(
  {
    name: "create-quiz",
    description:
      "Create a Kahoot-style multiplayer quiz with timed questions, auto-scoring, and a live leaderboard. Share the code so players can join.",
    schema: z.object({
      title: z.string().describe("Quiz title"),
      questions: z
        .array(
          z.object({
            question: z.string().describe("The question text"),
            options: z
              .preprocess(
                (val) => typeof val === "string" ? val.split(",").map((s) => s.trim()) : val,
                z.array(z.string()).min(2).max(4)
              )
              .describe("Answer choices (2–4 options), as an array or comma-separated string"),
            correctIndex: z
              .number()
              .int()
              .min(0)
              .describe("0-based index of the correct answer"),
            timeLimit: z
              .number()
              .int()
              .min(5)
              .max(120)
              .optional()
              .describe("Seconds to answer (default: 20)"),
          })
        )
        .min(1)
        .max(20)
        .describe("Quiz questions"),
    }),
    widget: {
      name: "quiz-widget",
      invoking: "Setting up your quiz...",
      invoked: "Quiz is ready!",
    },
  },
  async ({ title, questions }) => {
    const appId = generateAppId();
    const hostId = "host_" + randomUUID().slice(0, 6);

    const app: QuizApp = {
      appId,
      appType: "quiz",
      spec: {
        title,
        questions: questions.map((q) => ({
          ...q,
          timeLimit: q.timeLimit ?? 20,
        })),
      },
      state: {
        phase: "lobby",
        currentQuestion: 0,
        questionStartTime: null,
        answers: {},
        scores: {},
        players: {},
        hostId,
      },
      events: [],
      createdAt: Date.now(),
    };
    apps.set(appId, app);
    addEvent(app, "created", { title, questionCount: questions.length });

    return widget({
      props: {
        appId,
        appType: "quiz" as const,
        title,
        questions: app.spec.questions,
        phase: "lobby",
        currentQuestion: 0,
        questionStartTime: null,
        answers: {},
        scores: {},
        players: {},
        playerId: hostId,
        playerName: "Host",
        isHost: true,
      },
      output: text(
        [
          `Quiz "${title}" created with ${questions.length} question(s)!`,
          `Share code: **${appId}**`,
          `Phase: Lobby — waiting for players to join.`,
          ``,
          `Others can join by saying: "Join game ${appId} as [their name]"`,
          ``,
          `You are the host. Once players have joined, use "start-quiz" to begin.`,
          `Then use "next-question" to reveal answers and advance through questions.`,
        ].join("\n")
      ),
    });
  }
);

// ─── Tool: join-app ───────────────────────────────────────────────────────────

server.tool(
  {
    name: "join-app",
    description:
      "Join an existing poll or quiz using a share code. Returns the current game state so the player can participate.",
    schema: z.object({
      appId: z
        .string()
        .describe("The 6-character share code (e.g. A1B2C3)"),
      playerName: z
        .string()
        .describe("Your display name shown to others in the game"),
    }),
    widget: {
      name: "app-viewer",
      invoking: "Joining...",
      invoked: "Joined!",
    },
  },
  async ({ appId, playerName }) => {
    const normalized = appId.toUpperCase().replace(/\s/g, "");
    const app = apps.get(normalized);

    if (!app) {
      return text(
        `No app found with code "${normalized}". Double-check the code and try again.`
      );
    }

    const playerId = "p_" + randomUUID().slice(0, 6);

    if (app.appType === "poll") {
      return widget({
        props: {
          appId: normalized,
          appType: "poll" as const,
          isHost: false,
          playerName,
          playerId,
          title: app.spec.title,
          questions: app.spec.questions,
          multiChoice: app.spec.multiChoice,
          currentQuestion: app.state.currentQuestion,
          phase: app.state.phase,
          votes: app.state.votes,
          quizTitle: "",
          quizQuestions: [],
          quizPhase: "lobby",
          questionStartTime: null,
          answers: {},
          scores: {},
          players: {},
        },
        output: text(
          [
            `Joined poll "${app.spec.title}" as ${playerName}!`,
            `Player ID: ${playerId}`,
            ``,
            `--- Q${app.state.currentQuestion + 1}/${app.spec.questions.length}: ${app.spec.questions[app.state.currentQuestion].question} ---`,
            ...app.spec.questions[app.state.currentQuestion].options.map((opt, i) => `  ${i + 1}. ${opt}`),
            ``,
            `Phase: ${app.state.phase}`,
            `Vote by telling me which option you choose, or use "cast-vote" with the option text.`,
          ].join("\n")
        ),
      });
    }

    // Quiz: register player
    app.state.players[playerId] = playerName;
    if (!app.state.scores[playerId]) {
      app.state.scores[playerId] = { name: playerName, score: 0 };
    }
    addEvent(app, "player_joined", { playerId, playerName });

    return widget({
      props: {
        appId: normalized,
        appType: "quiz" as const,
        isHost: false,
        playerName,
        playerId,
        title: "",
        questions: [],
        multiChoice: false,
        currentQuestion: 0,
        phase: "lobby",
        votes: {},
        quizTitle: app.spec.title,
        quizQuestions: app.spec.questions,
        quizPhase: app.state.phase,
        questionStartTime: app.state.questionStartTime,
        answers: app.state.answers,
        scores: app.state.scores,
        players: app.state.players,
      },
      output: text(
        [
          `Joined quiz "${app.spec.title}" as ${playerName}!`,
          `Player ID: ${playerId}`,
          `Phase: ${app.state.phase}`,
          `Players in lobby: ${Object.values(app.state.players).join(", ") || "none yet"}`,
          ``,
          app.state.phase === "lobby"
            ? `Waiting for the host to start the quiz...`
            : `Quiz is in progress! Use "get-app-state" to see the current question.`,
        ].join("\n")
      ),
    });
  }
);

// ─── Tool: get-app-state (used by widgets for live polling) ──────────────────

server.tool(
  {
    name: "get-app-state",
    description:
      "Get the current live state of a poll or quiz. Returns the current question, phase, votes/answers, and scores. Use this to check for updates or present the current state to the user.",
    schema: z.object({
      appId: z.string().describe("The app share code"),
    }),
    outputSchema: z.object({
      found: z.boolean(),
      appType: z.enum(["poll", "quiz"]).optional(),
      votes: z.record(z.string(), z.record(z.string(), z.array(z.string()))).optional(),
      phase: z.string().optional(),
      currentQuestion: z.number().optional(),
      questionStartTime: z.number().nullable().optional(),
      answers: z
        .record(
          z.string(),
          z.record(
            z.string(),
            z.object({
              answerIndex: z.number(),
              timeMs: z.number(),
              playerName: z.string(),
            })
          )
        )
        .optional(),
      scores: z
        .record(z.string(), z.object({ name: z.string(), score: z.number() }))
        .optional(),
      players: z.record(z.string(), z.string()).optional(),
    }),
  },
  async ({ appId }) => {
    const app = apps.get(appId.toUpperCase().trim());
    if (!app) return object({ found: false });

    if (app.appType === "poll") {
      return object({
        found: true,
        appType: "poll" as const,
        currentQuestion: app.state.currentQuestion,
        phase: app.state.phase,
        votes: app.state.votes,
      });
    }

    return object({
      found: true,
      appType: "quiz" as const,
      phase: app.state.phase,
      currentQuestion: app.state.currentQuestion,
      questionStartTime: app.state.questionStartTime,
      answers: app.state.answers,
      scores: app.state.scores,
      players: app.state.players,
    });
  }
);

// ─── Tool: cast-vote ──────────────────────────────────────────────────────────

server.tool(
  {
    name: "cast-vote",
    description: "Cast a vote in a poll for the current question",
    schema: z.object({
      appId: z.string().describe("Poll share code"),
      questionIndex: z.number().int().describe("Current question index (0-based)"),
      option: z.string().describe("The option to vote for"),
      voterName: z.string().describe("Your display name"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
      votes: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
      totalVotes: z.number(),
    }),
  },
  async ({ appId, questionIndex, option, voterName }) => {
    const app = apps.get(appId.toUpperCase().trim());
    if (!app || app.appType !== "poll") {
      return object({ success: false, message: "Poll not found", votes: {}, totalVotes: 0 });
    }

    const { spec, state } = app;
    if (state.phase !== "voting") {
      return object({ success: false, message: "Not accepting votes right now", votes: state.votes, totalVotes: 0 });
    }
    if (state.currentQuestion !== questionIndex) {
      return object({ success: false, message: "Wrong question index", votes: state.votes, totalVotes: 0 });
    }

    const qKey = String(questionIndex);
    const currentQ = spec.questions[questionIndex];
    if (!currentQ || !currentQ.options.includes(option)) {
      return object({
        success: false,
        message: `Invalid option: "${option}"`,
        votes: state.votes,
        totalVotes: 0,
      });
    }

    if (!state.votes[qKey]) {
      state.votes[qKey] = {};
      for (const opt of currentQ.options) state.votes[qKey][opt] = [];
    }

    if (!spec.multiChoice) {
      for (const opt of currentQ.options) {
        state.votes[qKey][opt] = (state.votes[qKey][opt] || []).filter((v) => v !== voterName);
      }
    }

    if (!state.votes[qKey][option]) state.votes[qKey][option] = [];
    if (!state.votes[qKey][option].includes(voterName)) {
      state.votes[qKey][option].push(voterName);
    }

    addEvent(app, "vote_cast", { voterName, option, questionIndex });

    const qVotes = state.votes[qKey] ?? {};
    const totalVotes = Object.values(qVotes).flat().length;
    return object({
      success: true,
      message: `${voterName} voted for "${option}"`,
      votes: state.votes,
      totalVotes,
    });
  }
);

// ─── Tool: submit-quiz-answer ─────────────────────────────────────────────────

server.tool(
  {
    name: "submit-quiz-answer",
    description: "Submit an answer for the current quiz question",
    schema: z.object({
      appId: z.string().describe("Quiz share code"),
      playerId: z.string().describe("Your player ID (from join-app response)"),
      playerName: z.string().describe("Your display name"),
      questionIndex: z.number().int().describe("Current question index (0-based)"),
      answerIndex: z.number().int().describe("Your answer option index (0-based)"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
      isCorrect: z.boolean(),
      points: z.number(),
      totalScore: z.number(),
    }),
  },
  async ({ appId, playerId, playerName, questionIndex, answerIndex }) => {
    const app = apps.get(appId.toUpperCase().trim());
    if (!app || app.appType !== "quiz") {
      return object({ success: false, message: "Quiz not found", isCorrect: false, points: 0, totalScore: 0 });
    }

    const { spec, state } = app;

    if (state.phase !== "question") {
      return object({ success: false, message: "Not accepting answers right now", isCorrect: false, points: 0, totalScore: 0 });
    }
    if (state.currentQuestion !== questionIndex) {
      return object({ success: false, message: "Wrong question index", isCorrect: false, points: 0, totalScore: 0 });
    }
    if (state.answers[String(questionIndex)]?.[playerId]) {
      return object({ success: false, message: "Already answered", isCorrect: false, points: 0, totalScore: state.scores[playerId]?.score ?? 0 });
    }

    const timeMs = state.questionStartTime ? Date.now() - state.questionStartTime : 0;
    const question = spec.questions[questionIndex];
    const isCorrect = answerIndex === question.correctIndex;

    let points = 0;
    if (isCorrect) {
      const timeLimitMs = question.timeLimit * 1000;
      const ratio = Math.max(0, 1 - timeMs / timeLimitMs);
      points = Math.round(500 + 500 * ratio);
    }

    if (!state.answers[String(questionIndex)]) state.answers[String(questionIndex)] = {};
    state.answers[String(questionIndex)][playerId] = { answerIndex, timeMs, playerName };

    if (!state.scores[playerId]) state.scores[playerId] = { name: playerName, score: 0 };
    state.scores[playerId].score += points;
    state.players[playerId] = playerName;

    addEvent(app, "answer_submitted", { playerId, playerName, questionIndex, answerIndex, isCorrect, points });

    return object({
      success: true,
      message: isCorrect ? `Correct! +${points} pts` : "Wrong answer",
      isCorrect,
      points,
      totalScore: state.scores[playerId].score,
    });
  }
);

// ─── Tool: start-quiz ─────────────────────────────────────────────────────────

server.tool(
  {
    name: "start-quiz",
    description: "Start the quiz (host only) — moves from waiting lobby to the first question",
    schema: z.object({
      appId: z.string().describe("Quiz share code"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
      phase: z.string(),
      playerCount: z.number(),
    }),
  },
  async ({ appId }) => {
    const app = apps.get(appId.toUpperCase().trim());
    if (!app || app.appType !== "quiz") {
      return object({ success: false, message: "Quiz not found", phase: "error", playerCount: 0 });
    }
    if (app.state.phase !== "lobby") {
      return object({ success: false, message: "Quiz already started", phase: app.state.phase, playerCount: Object.keys(app.state.players).length });
    }

    app.state.phase = "question";
    app.state.currentQuestion = 0;
    app.state.questionStartTime = Date.now();

    const playerCount = Object.keys(app.state.players).length;
    addEvent(app, "quiz_started", { playerCount });

    return object({
      success: true,
      message: `Quiz started with ${playerCount} player(s)!`,
      phase: "question",
      playerCount,
    });
  }
);

// ─── Tool: next-question ──────────────────────────────────────────────────────

server.tool(
  {
    name: "next-question",
    description:
      "Advance the poll or quiz to the next phase (host only). Poll: voting → results → next question → ... → ended. Quiz: question → reveal → next question → ... → ended.",
    schema: z.object({
      appId: z.string().describe("App share code"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
      phase: z.string(),
      currentQuestion: z.number(),
    }),
  },
  async ({ appId }) => {
    const app = apps.get(appId.toUpperCase().trim());
    if (!app) {
      return object({ success: false, message: "App not found", phase: "error", currentQuestion: 0 });
    }

    // ── Poll flow: voting → results → next voting → ... → ended ──
    if (app.appType === "poll") {
      const { state, spec } = app;

      if (state.phase === "voting") {
        state.phase = "results";
        addEvent(app, "results_shown", { questionIndex: state.currentQuestion });
        return object({ success: true, message: "Showing results", phase: "results", currentQuestion: state.currentQuestion });
      }

      if (state.phase === "results") {
        const nextQ = state.currentQuestion + 1;
        if (nextQ >= spec.questions.length) {
          state.phase = "ended";
          addEvent(app, "poll_ended", {});
          return object({ success: true, message: "Poll finished!", phase: "ended", currentQuestion: state.currentQuestion });
        }
        state.currentQuestion = nextQ;
        state.phase = "voting";
        // Initialize votes for new question if needed
        if (!state.votes[String(nextQ)]) {
          state.votes[String(nextQ)] = {};
          for (const opt of spec.questions[nextQ].options) state.votes[String(nextQ)][opt] = [];
        }
        addEvent(app, "question_started", { questionIndex: nextQ });
        return object({ success: true, message: `Question ${nextQ + 1} started`, phase: "voting", currentQuestion: nextQ });
      }

      if (state.phase === "ended") {
        return object({ success: false, message: "Poll has already ended", phase: "ended", currentQuestion: state.currentQuestion });
      }

      return object({ success: false, message: `Cannot advance from phase: ${state.phase}`, phase: state.phase, currentQuestion: state.currentQuestion });
    }

    // ── Quiz flow: question → reveal → next question → ... → ended ──
    const { state, spec } = app;

    if (state.phase === "question") {
      state.phase = "reveal";
      addEvent(app, "reveal_started", { questionIndex: state.currentQuestion });
      return object({ success: true, message: "Showing correct answer", phase: "reveal", currentQuestion: state.currentQuestion });
    }

    if (state.phase === "reveal") {
      const nextQ = state.currentQuestion + 1;
      if (nextQ >= spec.questions.length) {
        state.phase = "ended";
        addEvent(app, "quiz_ended", { finalScores: state.scores });
        return object({ success: true, message: "Quiz finished! Final scores are live.", phase: "ended", currentQuestion: state.currentQuestion });
      }
      state.currentQuestion = nextQ;
      state.phase = "question";
      state.questionStartTime = Date.now();
      addEvent(app, "question_started", { questionIndex: nextQ });
      return object({ success: true, message: `Question ${nextQ + 1} started`, phase: "question", currentQuestion: nextQ });
    }

    if (state.phase === "ended") {
      return object({ success: false, message: "Quiz has already ended", phase: "ended", currentQuestion: state.currentQuestion });
    }

    return object({ success: false, message: `Cannot advance from phase: ${state.phase}`, phase: state.phase, currentQuestion: state.currentQuestion });
  }
);

// ─── Prompt: game host instructions ──────────────────────────────────────────

server.prompt(
  {
    name: "flexplay-instructions",
    description:
      "Instructions for hosting FlexPlay polls and quizzes. Load this to understand how to create, manage, and play games.",
  },
  async () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a FlexPlay game host. Here's how to run polls and quizzes:

## Creating Games
- **Poll**: Use "create-poll" with a title and array of questions (each with options). You can generate 1-20 questions on any topic.
- **Quiz**: Use "create-quiz" with a title and questions (each with options, correctIndex, and timeLimit).

## Game Flow

### Poll: voting → results → next question → ... → ended
1. Create poll → share the 6-character code
2. Others join with "join-app" using the code
3. Present the current question and options to the user
4. User tells you their choice → you call "cast-vote" with their option
5. Use "next-question" to show results, then again to advance to next question
6. After all questions, poll ends with a summary

### Quiz: lobby → question → reveal → ... → ended
1. Create quiz → share the code
2. Others join with "join-app"
3. Host uses "start-quiz" to begin
4. Present the question and options (numbered) to the user
5. User tells you their answer → you call "submit-quiz-answer" with the answerIndex
6. Host uses "next-question" to reveal the correct answer, then again for next question
7. After all questions, quiz ends with final scores

## For Text-Based Clients (no widget)
When the user can't see widgets, YOU must:
- Present questions and options clearly (numbered list)
- Accept the user's vote/answer as natural language ("I pick option 2" or "Paris")
- Call the appropriate tool (cast-vote or submit-quiz-answer)
- Use "get-app-state" to check for live updates and report them
- Announce results, scores, and winners

## Key Details
- Share codes are 6 characters (e.g. ABC123)
- Poll votes use the option TEXT (not index)
- Quiz answers use the option INDEX (0-based)
- "next-question" works for both polls and quizzes
- Anyone can call "get-app-state" to see current state`,
        },
      },
    ],
  })
);

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen().then(() => {
  console.log("FlexPlay server running!");
});
