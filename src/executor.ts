import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { PluginSettings } from "./types";

/** What one answer cost, as the CLI reports it. */
export interface TurnStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

// ── Path validation ────────────────────────────────────────────────────────────

const VALID_BINARY_NAMES = ["claude", "claude-code", "claude.cmd"];

function validatePaths(settings: PluginSettings): void {
  const name = path.basename(settings.claudeBinPath);
  if (!VALID_BINARY_NAMES.includes(name)) {
    throw new Error(
      `Unexpected binary name "${name}". Expected one of: ${VALID_BINARY_NAMES.join(", ")}`
    );
  }

  try {
    fs.accessSync(settings.claudeBinPath, fs.constants.X_OK);
  } catch {
    throw new Error(`Binary not found or not executable: ${settings.claudeBinPath}`);
  }

  if (settings.workingDirectory.trim()) {
    try {
      const stat = fs.statSync(settings.workingDirectory);
      if (!stat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${settings.workingDirectory}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Working directory does not exist: ${settings.workingDirectory}`);
      }
      throw err;
    }
  }
}

// ── Spawn options ──────────────────────────────────────────────────────────────

interface SpawnTarget {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * On Windows, .cmd files cannot be spawned directly by Node — they require
 * shell: true. On all other platforms shell is not needed.
 */
/**
 * The config directory of the account in use, with ~ expanded. Empty when no
 * accounts are configured, which leaves the CLI on its own default.
 */
export function resolveAccountDir(settings: PluginSettings): string {
  const wanted = settings.activeAccount?.trim();
  if (!wanted) return "";
  for (const line of (settings.accounts ?? "").split("\n")) {
    const [name, ...rest] = line.split("=");
    if (!rest.length) continue;
    if (name.trim() !== wanted) continue;
    const dir = rest.join("=").trim();
    const expanded = dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
    // Setting CLAUDE_CONFIG_DIR at all moves the CLI to a per-directory
    // credential bucket, so pointing it at the default directory hides the
    // ordinary `claude /login` and the panel reports "Not logged in". An
    // account on the default directory must leave the variable unset.
    return expanded === defaultConfigDir() ? "" : expanded;
  }
  return "";
}

/** Where the CLI keeps its config when CLAUDE_CONFIG_DIR is not set. */
function defaultConfigDir(): string {
  return path.join(os.homedir(), ".claude");
}

export function accountNames(settings: PluginSettings): string[] {
  return (settings.accounts ?? "")
    .split("\n")
    .map((line) => line.split("=")[0].trim())
    .filter((name) => name.length > 0);
}

function buildSpawnTarget(claudeBin: string, claudeArgs: string[]): SpawnTarget {
  const shell = process.platform === "win32";
  return { command: claudeBin, args: claudeArgs, shell };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Spawns the claude CLI and streams its response.
 *
 * @param skillId   Skill to invoke (e.g. "yara-and-sigma"). Null for follow-up
 *                  messages in an ongoing session (no skill prefix prepended).
 * @param text      The user message / selected text to send.
 * @param settings  Plugin settings (binary path, cwd, timeout, budget).
 * @param sessionId Previously captured session_id for multi-turn continuation
 *                  via --resume. Null to start a fresh session.
 * @param onChunk   Called with each streamed text delta as it arrives.
 * @param onDone    Called when the stream completes with (fullText, sessionId).
 *                  sessionId may be null if the CLI did not emit one.
 * @param onError   Called on fatal errors (spawn failure, timeout, non-zero exit).
 * @returns A cancel function that kills the subprocess if still running.
 */
export function runWithSkillStreaming(
  skillId: string | null,
  text: string,
  settings: PluginSettings,
  sessionId: string | null,
  onChunk: (text: string) => void,
  onDone: (fullText: string, sessionId: string | null, stats: TurnStats | null) => void,
  onError: (err: Error) => void
): () => void {
  try {
    validatePaths(settings);
  } catch (err) {
    onError(err as Error);
    return () => {};
  }

  // Build the message: skill invocations include the /{skillId} prefix;
  // follow-up messages in a resumed session are sent as-is.
  const message = skillId ? `/${skillId}\n\n${text}` : text;

  const claudeArgs = [
    "--print",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    // Every configured MCP server ships its full tool schema on every turn,
    // used or not. The servers in the CLI's user scope belong to other work
    // and cost ~25k input tokens a turn here, so the panel loads none of
    // them. Drop this flag to get them back.
    "--strict-mcp-config",
  ];

  // Focused mode: the answer must come from what the user dragged in, so the
  // CLI gets no tools - it cannot read the vault, search it, or run anything.
  if (settings.focusedMode) {
    claudeArgs.push("--tools", "");
  }

  if (settings.maxBudgetUsd > 0) {
    claudeArgs.push("--max-budget-usd", String(settings.maxBudgetUsd));
  }

  // Resume an existing session for multi-turn conversation
  if (sessionId) {
    claudeArgs.push("--resume", sessionId);
  }

  const { command, args, shell } = buildSpawnTarget(settings.claudeBinPath, claudeArgs);
  const configDir = resolveAccountDir(settings);

  // Fall back to home directory if working directory is not configured
  const cwd = settings.workingDirectory.trim() || os.homedir();

  const proc = spawn(command, args, {
    cwd,
    shell,
    env: {
      ...process.env,
      HOME: os.homedir(),
      CLAUDE_OBSIDIAN_PLUGIN: "1",
      // Each account has its own CLI config directory, which is where the
      // login lives. Switching accounts is switching this.
      ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    },
  });

  proc.stdin.write(message);
  proc.stdin.end();

  let buffer = "";
  let finalResult = "";
  let capturedSessionId: string | null = null;
  let stats: TurnStats | null = null;
  let killed = false;
  let errorSubtype = "";
  let stderrText = "";

  // The timeout is idle time, not total time. A long answer streams deltas
  // the whole way through, and a long tool call still emits events, so the
  // clock only runs out when the CLI has genuinely gone quiet. Measuring
  // total time instead killed perfectly healthy turns at two minutes.
  let timeoutId = 0;
  const stopTimer = () => {
    if (timeoutId) {
      activeWindow.clearTimeout(timeoutId);
      timeoutId = 0;
    }
  };
  const resetTimer = () => {
    stopTimer();
    timeoutId = activeWindow.setTimeout(() => {
      if (!killed) {
        killed = true;
        proc.kill();
        onError(
          new Error(`Claude went quiet for ${settings.timeout / 1000}s — stopped.`),
        );
      }
    }, settings.timeout);
  };
  resetTimer();

  proc.stdout.on("data", (rawChunk: Buffer) => {
    resetTimer();
    buffer += rawChunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      // Streamed text deltas
      if (
        event.type === "stream_event" &&
        event.event &&
        typeof event.event === "object"
      ) {
        const inner = event.event as Record<string, unknown>;
        if (
          inner.type === "content_block_delta" &&
          inner.delta &&
          typeof inner.delta === "object"
        ) {
          const delta = inner.delta as { type?: string; text?: string };
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            onChunk(delta.text);
          }
        }
      }

      // Final result — captures full text, session_id for --resume, and what
      // the turn cost, which is the only honest way to answer "is this
      // expensive?" for a given question.
      if (event.type === "result") {
        if (typeof event.result === "string") {
          finalResult = event.result;
        }
        // A failed turn carries no result text at all, so without this the
        // panel would just show the cost line and nothing else. The budget
        // cap is the usual culprit: it stops the run mid tool call.
        if (event.is_error === true && typeof event.subtype === "string") {
          errorSubtype = event.subtype;
        }
        if (typeof event.session_id === "string") {
          capturedSessionId = event.session_id;
        }
        const usage = event.usage as Record<string, number> | undefined;
        if (usage || typeof event.total_cost_usd === "number") {
          stats = {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
            costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
          };
        }
      }
    }
  });

  proc.stderr.on("data", (rawChunk: Buffer) => {
    resetTimer();
    stderrText += rawChunk.toString("utf8");
  });

  proc.on("close", () => {
    stopTimer();
    if (killed) return;
    if (!finalResult && errorSubtype) {
      onError(new Error(describeFailure(errorSubtype, settings)));
      return;
    }
    if (!finalResult && stderrText.trim()) {
      onError(new Error(stderrText.trim().split("\n")[0]));
      return;
    }
    onDone(finalResult, capturedSessionId, stats);
  });

  proc.on("error", (err: Error) => {
    stopTimer();
    if (!killed) {
      killed = true;
      onError(err);
    }
  });

  return () => {
    if (!killed) {
      killed = true;
      stopTimer();
      proc.kill();
    }
  };
}

/** Turn a CLI failure subtype into something that says what to change. */
function describeFailure(subtype: string, settings: PluginSettings): string {
  if (subtype === "error_max_budget_usd") {
    return (
      `Stopped: the turn hit the $${settings.maxBudgetUsd} budget cap before Claude ` +
      "finished, so nothing was written. Raise \"Max budget\" in the plugin " +
      "settings, or set it to 0 to remove the cap."
    );
  }
  if (subtype === "error_max_turns") {
    return "Stopped: Claude hit the maximum number of turns before finishing.";
  }
  return `Claude ended with an error (${subtype}).`;
}
