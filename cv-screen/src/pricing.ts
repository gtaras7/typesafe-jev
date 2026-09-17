/**
 * What a run costs, in the currency a recruiter understands.
 *
 * Published price, from https://docs.typesafe.ai/models.md (Jev 1.13):
 *   $42 per billion tokens = $0.042 per million input tokens, charged on input only.
 *   Output tokens are free.
 *
 * The number is here rather than in the UI so the header, the CSV and the report all
 * quote the same figure, and so a price change is one line in one place.
 */

export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export function costUsd(inputTokens: number): number {
  return inputTokens * USD_PER_INPUT_TOKEN;
}

/** Enough precision to show that one CV is a fraction of a cent. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
