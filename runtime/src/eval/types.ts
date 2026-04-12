/**
 * Eval types — defines fixtures, expectations, and scored results.
 */

export interface FixtureMessage {
  login: string;
  twitchId: string;
  text: string;
  /** Timestamp offset in seconds from fixture start */
  offsetSec: number;
}

export interface FixtureExpectation {
  /** Should the bot reply to this message? */
  shouldReply: boolean | "maybe";
  /** If it replies, should it propose an action? */
  shouldPropose: boolean | "maybe" | null;
  /** If it proposes, what action type? */
  expectedAction?: string;
  /** If it proposes, should policy deny? */
  shouldDeny?: boolean;
  /** Notes about why this expectation exists */
  reason?: string;
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
  /** Pre-existing viewer lore (loaded before replay) */
  viewerLore?: Record<string, string[]>;
  /** Pre-existing channel notes */
  channelNotes?: string[];
  /** The chat transcript to replay */
  messages: FixtureMessage[];
  /** Per-message expectations (indexed by message index) */
  expectations: Record<number, FixtureExpectation>;
}

export interface EvalResult {
  messageIndex: number;
  message: FixtureMessage;
  replied: boolean;
  replyText: string | null;
  proposedAction: string | null;
  policyVerdict: string | null;
  expectation: FixtureExpectation | null;
  scores: {
    replyCorrect: boolean | null;      // null = no expectation
    actionCorrect: boolean | null;
    policyCorrect: boolean | null;
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
    overallScore: number | null;
  };
}
