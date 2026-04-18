import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "./config.js";

/**
 * Build the CLI args for `claude -p`.
 */
function buildArgs(prompt: string, systemPrompt?: string): string[] {
  const args = ["-p", prompt];

  if (config.claudeMode === "lean") {
    args.push("--setting-sources", config.claudeSettingSources);
  }
  // "full" = no flags, load everything

  if (config.claudeSettings) {
    args.push("--settings", config.claudeSettings);
  }

  if (config.mcpConfig) {
    args.push("--mcp-config", config.mcpConfig);
    if (config.strictMcpConfig) {
      args.push("--strict-mcp-config");
    }
  }

  if (config.allowedTools) {
    args.push("--allowedTools", config.allowedTools);
  }

  if (config.disallowedTools) {
    args.push("--disallowedTools", config.disallowedTools);
  }

  if (config.permissionMode) {
    args.push("--permission-mode", config.permissionMode);
  }

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  if (config.claudeAppendSystemPrompt) {
    args.push("--append-system-prompt", config.claudeAppendSystemPrompt);
  }

  if (config.claudeModel) {
    args.push("--model", config.claudeModel);
  }

  if (config.maxTurnCount > 0) {
    args.push("--max-turns", String(config.maxTurnCount));
  }

  return args;
}

/**
 * Event emitted while streaming the Claude CLI in stream-json mode.
 * - "text": an assistant text block arrived
 * - "tool_use": the agent called a tool (including built-ins and MCP tools)
 * - "done": the final result event (final text + stop reason + cost/timing)
 * - "error": fatal stream error (bad JSON, non-zero exit without output, etc.)
 */
export type ClaudeEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "done"; stopReason: string | null; finalText: string; costUsd?: number; durationMs?: number }
  | { type: "error"; message: string };

/**
 * One content block in the aggregated (non-stream) response.
 * Order matches the order events arrived from the CLI.
 */
export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ClaudeAggregated {
  blocks: ClaudeContentBlock[];
  stopReason: string | null;
  finalText: string;
  costUsd?: number;
  durationMs?: number;
}

/**
 * Run claude CLI to completion and aggregate all text + tool_use events
 * into a single response. Uses the same stream-json parser as the streaming
 * path, so tool calls are preserved in the non-streaming response body.
 */
export function execClaudeAggregate(prompt: string, systemPrompt?: string): Promise<ClaudeAggregated> {
  return new Promise((resolve, reject) => {
    const blocks: ClaudeContentBlock[] = [];
    let stopReason: string | null = null;
    let finalText = "";
    let costUsd: number | undefined;
    let durationMs: number | undefined;

    execClaudeStreamJson(
      prompt,
      (event) => {
        if (event.type === "text") {
          blocks.push({ type: "text", text: event.text });
        } else if (event.type === "tool_use") {
          blocks.push({ type: "tool_use", id: event.id, name: event.name, input: event.input });
        } else if (event.type === "done") {
          stopReason = event.stopReason;
          finalText = event.finalText;
          costUsd = event.costUsd;
          durationMs = event.durationMs;
          resolve({ blocks, stopReason, finalText, costUsd, durationMs });
        } else if (event.type === "error") {
          reject(new Error(event.message));
        }
      },
      systemPrompt
    );
  });
}

/**
 * Run claude CLI with --output-format stream-json and emit structured events.
 * Requires --verbose (enforced by the CLI when combined with -p).
 */
export function execClaudeStreamJson(
  prompt: string,
  onEvent: (event: ClaudeEvent) => void,
  systemPrompt?: string
): { proc: ChildProcessWithoutNullStreams } {
  const args = [...buildArgs(prompt, systemPrompt), "--output-format", "stream-json", "--verbose"];

  const proc = spawn(config.claudeBinary, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let lineBuf = "";
  let stderr = "";
  let finalText = "";

  const emit = (event: ClaudeEvent) => {
    try {
      onEvent(event);
    } catch {
      // ignore consumer errors — don't kill the stream
    }
  };

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // skip non-JSON lines
    }

    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          emit({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          emit({
            type: "tool_use",
            id: block.id ?? "",
            name: block.name ?? "",
            input: block.input ?? {},
          });
        }
        // thinking blocks and others: ignore
      }
    } else if (msg.type === "result") {
      if (typeof msg.result === "string") finalText = msg.result;
      emit({
        type: "done",
        stopReason: msg.stop_reason ?? null,
        finalText,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
      });
    }
    // system/user/rate_limit_event: ignore
  };

  proc.stdout.on("data", (chunk: Buffer) => {
    lineBuf += chunk.toString();
    let nl;
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      handleLine(lineBuf.slice(0, nl));
      lineBuf = lineBuf.slice(nl + 1);
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  proc.on("close", (code) => {
    if (lineBuf.trim()) handleLine(lineBuf);
    if (code !== 0 && !finalText) {
      emit({ type: "error", message: `claude exited with code ${code}: ${stderr.trim()}` });
    }
  });

  proc.on("error", (err) => {
    emit({ type: "error", message: `Failed to spawn claude: ${err.message}` });
  });

  proc.stdin.end();
  return { proc };
}
