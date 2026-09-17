/**
 * Wire types for the TypeSafe System One API.
 *
 * Transcribed from the live docs (https://docs.typesafe.ai/api.md) rather than
 * guessed, so the compiler checks every request we build and every answer we read.
 *
 * POST https://api.typesafe.ai/v1/systemone
 */

export type QuestionId = string;

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option name -> rubric description (null when an option needs no extra detail) */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** ordered levels, at least two */
  criteria: Array<string | { what: string; examples?: string[] }>;
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<QuestionId, Question>;

export interface NoulAnswer {
  type: "noul";
  /** probability the answer is yes, 0..1 */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** probability-weighted position, can land between levels */
  score: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Record<QuestionId, Answer>;

export interface SystemOneResponse {
  model: string;
  answers: Answers;
  usage: { input_tokens: number; output_tokens: number };
}

export interface SystemOneRequest {
  state: unknown;
  model: string;
  questions: Questions;
}

export const DEFAULT_MODEL = "jev-latest";
export const API_URL = "https://api.typesafe.ai/v1/systemone";
