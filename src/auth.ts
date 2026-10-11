import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { cliEnv } from "./executor";
import type { PluginSettings } from "./types";

/** What `claude auth status` says about one config directory. */
export interface AuthStatus {
  loggedIn: boolean;
  email: string;
  orgId: string;
  orgName: string;
}

/**
 * Asks the CLI whether the account on this config directory is logged in.
 * The command exits 1 when it is not, but still prints its JSON, so the
 * output is read either way.
 */
export function readAuthStatus(settings: PluginSettings, configDir: string): Promise<AuthStatus> {
  return new Promise((resolve, reject) => {
    execFile(
      settings.claudeBinPath,
      ["auth", "status", "--json"],
      { env: cliEnv(configDir), cwd: os.homedir(), timeout: 20000 },
      (err, stdout) => {
        try {
          const j = JSON.parse(stdout) as Record<string, unknown>;
          resolve({
            loggedIn: j.loggedIn === true,
            email: typeof j.email === "string" ? j.email : "",
            orgId: typeof j.orgId === "string" ? j.orgId : "",
            orgName: typeof j.orgName === "string" ? j.orgName : "",
          });
        } catch {
          reject(err ?? new Error("Could not read the login status"));
        }
      }
    );
  });
}

export interface LoginHandle {
  /** Passes on the code the sign-in page shows when it cannot call back. */
  sendCode(code: string): void;
  cancel(): void;
}

/**
 * Runs `claude auth login` for one config directory. Without a terminal it
 * still works: it opens the sign-in page in the default browser and exits 0
 * once the page calls back to it. It also prints a second link whose page
 * shows a code instead of calling back - the way to sign in from a private
 * window, as a different account - and reads that code from stdin.
 */
export function startLogin(
  settings: PluginSettings,
  configDir: string,
  on: {
    url: (url: string) => void;
    done: () => void;
    failed: (message: string) => void;
  }
): LoginHandle {
  let finished = false;
  let out = "";
  let urlSeen = false;

  try {
    if (configDir) fs.mkdirSync(configDir, { recursive: true });
  } catch (err) {
    on.failed(`Could not create ${configDir}: ${(err as Error).message}`);
    return { sendCode: () => {}, cancel: () => {} };
  }

  const proc = spawn(settings.claudeBinPath, ["auth", "login"], {
    env: cliEnv(configDir),
    cwd: os.homedir(),
  });

  const read = (chunk: Buffer) => {
    out += chunk.toString("utf8");
    // Wait for the whitespace after the link, so a link split across two
    // chunks is not passed on half-read.
    const m = out.match(/visit:\s*(https:\/\/\S+)\s/);
    if (m && !urlSeen) {
      urlSeen = true;
      on.url(m[1]);
    }
  };
  proc.stdout.on("data", read);
  proc.stderr.on("data", read);

  proc.on("close", (code) => {
    if (finished) return;
    finished = true;
    if (code === 0) {
      on.done();
      return;
    }
    const failure = out.match(/Login failed[^\n]*/);
    const last = out.trim().split("\n").pop() ?? "";
    on.failed(failure ? failure[0] : last || `claude auth login stopped (exit ${code})`);
  });

  proc.on("error", (err) => {
    if (finished) return;
    finished = true;
    on.failed(err.message);
  });

  return {
    sendCode: (code: string) => {
      if (!finished) proc.stdin.write(code.trim() + "\n");
    },
    cancel: () => {
      if (finished) return;
      finished = true;
      proc.kill();
    },
  };
}
