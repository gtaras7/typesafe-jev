/**
 * Minimal .env loader. No dependency, loads only the project's own .env.
 *
 * Real environment variables always win, so `TYPESAFE_API_KEY=... npm run screen`
 * and CI secrets still override the file.
 *
 * Loaded as a side effect of importing this module; src/cli.ts imports it first.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, "..", ".env");

export function loadDotEnv(path = ENV_PATH): { loaded: string[]; path: string } {
  const loaded: string[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { loaded, path }; // no .env is fine
  }

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;

    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return { loaded, path };
}

export const ENV_FILE_PATH = ENV_PATH;

/**
 * Loaded once when this module is first imported, so importing `env.js` anywhere
 * (client, CLI, scripts) is enough to pick up the project .env.
 */
export const ENV_LOAD_RESULT = loadDotEnv();
