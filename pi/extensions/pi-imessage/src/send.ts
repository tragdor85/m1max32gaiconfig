import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const OSA = "/usr/bin/osascript";

/**
 * AppleScript send. Text and target are passed as argv items so no quoting or
 * escaping is ever needed (the obfuscated original used the same approach).
 * `osascript -e <script> <arg1> <arg2>` forwards trailing arguments to the
 * script's `on run argv` handler.
 */
const SCRIPT = `on run argv
	set m to item 1 of argv
	set b to item 2 of argv
	tell application "Messages"
		send m to buddy b
	end tell
end run`;

export interface SendResult {
  ok: boolean;
  error?: string;
}

export function canSend(): boolean {
  return Boolean(process.env.PI_IMESSAGE_SEND_CMD) || (process.platform === "darwin" && existsSync(OSA));
}

/** Resolve the executable + args for one send. PI_IMESSAGE_SEND_CMD overrides osascript (test hook): the executable receives "<target> <text>" as argv. */
function spawnArgs(text: string, target: string): { cmd: string; args: string[] } {
  const hook = process.env.PI_IMESSAGE_SEND_CMD;
  if (hook) return { cmd: hook, args: [target, text] };
  return { cmd: OSA, args: ["-e", SCRIPT, text, target] };
}

export function sendImessage(text: string, target: string, timeoutMs = 15000): Promise<SendResult> {
  return new Promise((resolve) => {
    if (!canSend()) {
      resolve({ ok: false, error: "not on macOS or osascript not found" });
      return;
    }
    let settled = false;
    const done = (r: SendResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let child;
    try {
      const { cmd, args } = spawnArgs(text, target);
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ ok: false, error: String((e as Error)?.message ?? e) });
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      done({ ok: false, error: `osascript timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      done({ ok: false, error: String(e.message ?? e) });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) done({ ok: true });
      else done({ ok: false, error: stderr.trim() || `osascript exited with code ${code}` });
    });
  });
}
