import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ImeConfig {
  /** Own identities (own phone numbers / emails) — self-chat detection. May include user-added aliases. */
  meHandles: string[];
  /** Allowlist: only these handles reach the agent (inbound) and are sendable (outbound). */
  allowFrom: string[];
  /** Polling is OFF by default. */
  pollingEnabled: boolean;
  pollIntervalMs: number;
}

export const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "pi-imessage");
export const CONFIG_FILE: string = process.env.PI_IMESSAGE_CONFIG || path.join(CONFIG_DIR, "config.json");

/** JSONL log of denied (not-allowlisted) inbound messages — not printed to the console. */
export const DENIED_LOG_FILE: string = path.join(path.dirname(CONFIG_FILE), "denied.log");

export function defaultConfig(): ImeConfig {
  return { meHandles: [], allowFrom: [], pollingEnabled: false, pollIntervalMs: 1000 };
}

export function loadConfig(): ImeConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
    const def = defaultConfig();
    const strArr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : undefined);
    return {
      meHandles: strArr(raw.meHandles) ?? [],
      allowFrom: strArr(raw.allowFrom) ?? [],
      pollingEnabled: typeof raw.pollingEnabled === "boolean" ? raw.pollingEnabled : def.pollingEnabled,
      pollIntervalMs:
        typeof raw.pollIntervalMs === "number" && raw.pollIntervalMs > 0
          ? Math.round(raw.pollIntervalMs)
          : def.pollIntervalMs,
    };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cfg: ImeConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    console.error(`pi-imessage: failed to save ${CONFIG_FILE}: ${String((e as Error)?.message ?? e)}`);
  }
}

/** Normalize a handle for comparison: lowercase, trim, no whitespace. */
export function normHandle(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "");
}

function digitsOnly(h: string): string {
  return h.replace(/\D+/g, "");
}

/**
 * Handle equality. Exact after normalization, or phone-number match on the last
 * 10 digits (tolerates missing/added country code). Emails are exact.
 */
export function sameHandle(a: string, b: string): boolean {
  const na = normHandle(a);
  const nb = normHandle(b);
  if (na === nb) return true;
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da.length >= 10 && db.length >= 10 && da.slice(-10) === db.slice(-10)) return true;
  // e-mail local-part is case-insensitive but the domain must match exactly; covered by na===nb already.
  return false;
}

/** Set of normalized handles for fast membership tests. */
export function normSet(handles: string[]): Set<string> {
  return new Set(handles.map(normHandle));
}
