/**
 * Minimal client for the TypeSafe System One endpoint.
 *
 * Plain fetch on purpose: the documented HTTP contract is a single POST, so the same
 * request shape can be lifted into any HTTP client or workflow tool.
 * (@typesafe-ai/sdk v0.6.0 exists and infers answer types from your questions if
 * you would rather use it inside a TS app.)
 */

import {
  API_URL,
  DEFAULT_MODEL,
  type Questions,
  type SystemOneResponse,
  type SystemOneRequest,
} from "./types.js";
// Side-effect import: fills TYPESAFE_API_KEY from the project .env when it is not
// already in the real environment. Only sets variables that are unset, so a
// deployment or CI value always wins. Keeps scripts and tests from tripping over
// "key not set" while the CLI already worked.
import "./env.js";

export interface CallOptions {
  apiKey?: string;
  model?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TypeSafeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "TypeSafeError";
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function systemOne(
  state: unknown,
  questions: Questions,
  opts: CallOptions = {},
): Promise<SystemOneResponse> {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new TypeSafeError(
      "TYPESAFE_API_KEY is not set. Get a key at https://console.typesafe.ai/settings/keys",
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxAttempts = opts.maxAttempts ?? 4;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const body: SystemOneRequest = { state, model, questions };
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
          lastErr = new TypeSafeError(`HTTP ${res.status}`, res.status, text);
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw new TypeSafeError(
          `TypeSafe API returned HTTP ${res.status}: ${text.slice(0, 500)}`,
          res.status,
          text,
        );
      }
      const parsed = JSON.parse(text) as SystemOneResponse;
      if (!parsed.answers) {
        throw new TypeSafeError(`response had no answers: ${text.slice(0, 500)}`, res.status, text);
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof TypeSafeError ? err.status === undefined : true;
      if (attempt < maxAttempts && retryable) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new TypeSafeError(String(lastErr));
}
