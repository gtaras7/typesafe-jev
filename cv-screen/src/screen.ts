/**
 * Screening one CV end to end: build state, ask all judgments in a single request,
 * then compose the score in code.
 *
 * State is an object with named fields so the model can tell the CV text from the
 * role requirements, and so the same CV can be scored against several policies without
 * changing any judgment meaning.
 */

import { buildQuestions } from "./questions.js";
import { compose, type ScreenResult } from "./compose.js";
import { systemOne, type CallOptions } from "./client.js";
import { asPolicy, type Policy } from "./policy.js";
import type { RoleSpec } from "./role-spec.js";
import type { Answers, Questions, SystemOneResponse } from "./types.js";

export interface ScreenInput {
  cvText: string;
  name: string;
  email: string;
  extra?: Record<string, unknown>;
}

export interface ScreenOptions extends CallOptions {
  /** Override "today" so age judgments are reproducible in tests. */
  today?: string;
}

export interface ScreenOutcome {
  result: ScreenResult;
  state: unknown;
  questions: Questions;
  answers: Answers;
  usage: SystemOneResponse["usage"];
  model: string;
}

export function buildState(
  policyOrRole: Policy | RoleSpec,
  input: ScreenInput,
  today: string,
): unknown {
  const policy = asPolicy(policyOrRole);
  return {
    candidate: { name: input.name, email: input.email },
    cv_text: input.cvText,
    role: {
      title: policy.roleTitle,
      min_experience_years: policy.minExperienceYears,
      accepted_education: policy.acceptedEducation.map((e) => e.match || e.label),
      stability_rule: `no more than ${policy.stability.maxEmployers} distinct employers in the last ${policy.stability.windowYears} years`,
      today,
    },
    ...(input.extra ?? {}),
  };
}

export async function screenCv(
  policyOrRole: Policy | RoleSpec,
  input: ScreenInput,
  opts: ScreenOptions = {},
): Promise<ScreenOutcome> {
  const policy = asPolicy(policyOrRole);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const questions = buildQuestions(policy, today);
  const state = buildState(policy, input, today);

  const response = await systemOne(state, questions, opts);
  const result = compose(policy, questions, response.answers, {
    name: input.name,
    email: input.email,
  });

  return {
    result,
    state,
    questions,
    answers: response.answers,
    usage: response.usage,
    model: response.model,
  };
}
