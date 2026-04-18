import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "./config.js";

export interface ClaudeResult {
  text: string;
  exitCode: number;
}

/**
 * Build the CLI args for `claude -p --bare`.
 */
function buildArgs(prompt: string, systemPrompt?: string): string[] {
  const args = ["-p", prompt];

  if (config.claudeMode === "bare") {
    args.push("--bare");
  } else if (config.claudeMode === "lean") {
    args.push("--setting-sources", config.claudeSettingSources);
  }
  // "full" = no flags, load everything

  if (config.claudeSettings) {
    args.push("--settings", config.claudeSettings);
  }

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  if (config.claudeModel) {
    args.push("--model", config.claudeModel);
  }

  if (config.maxTurnCount) {
    args.push("--max-turns", String(config.maxTurnCount));
  }

  return args;
}

/**
 * Run claude CLI and collect the full response.
 */
export async function execClaude(prompt: string, systemPrompt?: string): Promise<ClaudeResult> {
  const args = buildArgs(prompt, systemPrompt);

  return new Promise((resolve, reject) => {
    const cliEnv = { ...process.env };
    if (!cliEnv.ANTHROPIC_API_KEY && cliEnv.CLAUDE_CODE_OAUTH_TOKEN) {
      cliEnv.ANTHROPIC_API_KEY = cliEnv.CLAUDE_CODE_OAUTH_TOKEN;
    }
    const proc = spawn(config.claudeBinary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: cliEnv,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }
      resolve({ text: stdout.trim(), exitCode: code ?? 0 });
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.stdin.end();
  });
}

/**
 * Run claude CLI and stream partial results via callback.
 * --bare outputs raw text, so every stdout chunk is a delta.
 */
export function execClaudeStream(
  prompt: string,
  onDelta: (delta: string) => void,
  onDone: (fullText: string) => void,
  onError: (err: Error) => void,
  systemPrompt?: string
): { proc: ChildProcessWithoutNullStreams } {
  const args = buildArgs(prompt, systemPrompt);

  const cliEnv = { ...process.env };
  if (!cliEnv.ANTHROPIC_API_KEY && cliEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    cliEnv.ANTHROPIC_API_KEY = cliEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const proc = spawn(config.claudeBinary, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: cliEnv,
  });

  let fullText = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    const delta = chunk.toString();
    fullText += delta;
    onDelta(delta);
  });

  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  proc.on("close", (code) => {
    if (code !== 0 && !fullText) {
      onError(new Error(`claude exited with code ${code}: ${stderr}`));
    } else {
      onDone(fullText);
    }
  });

  proc.on("error", (err) => {
    onError(new Error(`Failed to spawn claude: ${err.message}`));
  });

  proc.stdin.end();
  return { proc };
}
