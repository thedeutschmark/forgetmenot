/**
 * Eval types — defines fixtures, expectations, and scored results.
 *
 * Retrieval scoring (added 2026-04-13): fixtures may identify seeded notes
 * by stable string IDs and per-message expectations may include
 * `expectRetrieved`. Hit@k and recall are the primary signals; precision
 * and F1 are reported but not the metric we tune against.
 */

export interface FixtureMessage {
  login: string;
  twitchId: string;
  text: string;
  /** Timestamp offset in seconds from fixture start */
  offsetSec: number;
}

/**
 * A seeded note with a stable fixture-scoped ID. Fixtures may also use the
 * legacy `string` shape (just the fact); the runner treats those as anonymous
 * and they cannot be referenced from `expectRetrieved`.
 */
export interface FixtureNote {
  id: string;
  fact: string;
}

export type FixtureNoteList = string[] | FixtureNote[];

export interface FixtureExpectation {
  /** Should the bot reply to this message? */
  shouldReply: boolean | "maybe";
  /** If it replies, should it propose an action? */
  shouldPropose: boolean | "maybe" | null;
  /** If it proposes, what action type? */
  expectedAction?: string;
  /** If it proposes, should policy deny? */
  shouldDeny?: boolean;
  /**
   * Fixture note IDs that should appear in the post-budget-trim retrieved set.
   * Optional — messages without it are not scored for retrieval.
   */
  expectRetrieved?: string[];
  /**
   * Deterministic text-quality rubric applied to the reply text.
   * All criteria must pass for textCorrect=true. Any single failure → false.
   * Omitted rubric → textCorrect=null (not scored).
   *
   * Added 2026-04-17 to catch voice-discipline failures the existing
   * shouldReply/shouldPropose axes don't measure (rule 3 banned openers,
   * rule 3a bot-substrate narration, rule 3b semicolons/em-dashes, rule 8
   * flat-answer preference, double-@ tagging, pathos word-count ceiling).
   */
  textRubric?: TextRubric;
  /** Notes about why this expectation exists */
  reason?: string;
}

export interface TextRubric {
  /** Substrings that MUST appear (case-insensitive). All must match. */
  mustContain?: string[];
  /** Substrings that must NOT appear (case-insensitive). Any match → fail. */
  mustNotContain?: string[];
  /** Regex patterns (case-insensitive) that must NOT match. Any hit → fail. */
  mustNotMatch?: string[];
  /** Reply word count must be ≤ this. "@login" prefix is not counted. */
  maxWords?: number;
  /** Count of "?" in reply must be ≤ this. */
  maxQuestions?: number;
  /**
   * If true, reply text must NOT contain "@<message_login>" anywhere.
   * The engine auto-prepends the @mention; any inline repeat produces a
   * visible double-tag in chat. Catches the okay_chr1s failure pattern.
   */
  noDoubleAt?: boolean;
}

export interface TextScores {
  /** Overall pass/fail. */
  pass: boolean;
  /** Human-readable failure reasons (empty when pass=true). */
  failures: string[];
}

export interface EvalFixture {
  id: string;
  name: string;
  description: string;
  /** Channel context for the fixture */
  channel?: {
    title?: string;
    category?: string;
  };
  /** Pre-existing viewer lore (loaded before replay). Either string[] or FixtureNote[]. */
  viewerLore?: Record<string, FixtureNoteList>;
  /** Pre-existing channel notes. Either string[] or FixtureNote[]. */
  channelNotes?: FixtureNoteList;
  /** The chat transcript to replay */
  messages: FixtureMessage[];
  /** Per-message expectations (indexed by message index) */
  expectations: Record<number, FixtureExpectation>;
  /**
   * Override the prompt budget for this fixture (default 1500). Used by the
   * budget-trim fixture to deterministically force trim behavior with a
   * tighter cap, so the trim algorithm itself is exercised regardless of
   * how much real lore we'd need to seed to hit the production budget.
   */
  maxInputTokens?: number;
}

/**
 * Per-message retrieval scores. Computed only when the message has
 * `expectRetrieved` AND the runner produced a retrieved set.
 */
export interface RetrievalScores {
  /** 1 if any expected ID is in the retrieved set, else 0 */
  hitAtK: number | null;
  /** Expected ∩ retrieved / |expected| */
  recall: number | null;
  /** Expected ∩ retrieved / |retrieved| */
  precision: number | null;
  /** Harmonic mean of precision and recall */
  f1: number | null;
}

export interface EvalResult {
  messageIndex: number;
  message: FixtureMessage;
  replied: boolean;
  replyText: string | null;
  proposedAction: string | null;
  policyVerdict: string | null;
  expectation: FixtureExpectation | null;
  /** Fixture IDs of notes the LLM actually saw (post-budget-trim). */
  retrievedNoteIds: string[];
  scores: {
    replyCorrect: boolean | null;      // null = no expectation
    actionCorrect: boolean | null;
    policyCorrect: boolean | null;
    retrieval: RetrievalScores | null; // null = no retrieval expectation
    text: TextScores | null;           // null = no textRubric
  };
}

export interface EvalReport {
  fixtureId: string;
  fixtureName: string;
  runAt: string;
  totalMessages: number;
  totalExpectations: number;
  results: EvalResult[];
  summary: {
    replyAccuracy: number | null;
    actionAccuracy: number | null;
    policyAccuracy: number | null;
    /** Macro-average over messages with retrieval expectations. */
    retrievalHitAtK: number | null;
    retrievalRecall: number | null;
    retrievalPrecision: number | null;
    retrievalF1: number | null;
    /** Pass rate over messages with text rubrics. */
    textAccuracy: number | null;
    overallScore: number | null;
  };
}
