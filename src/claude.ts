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
 * Upstream Anthropic sometimes surfaces rate-limit / overage rejections as an
 * assistant text block whose ONLY content is this exact string. It's neither
 * our router's auth failure nor a genuine response. We detect and retry it
 * transparently (see execClaudeStreamJsonWithRetry).
 */
const UPSTREAM_TRANSIENT_ERROR = "Invalid API key · Fix external API key";

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
 * Returns true if the aggregated response is just the upstream transient error
 * (meaning retries were exhausted). Callers should surface this as a 503.
 */
export function isUpstreamTransientFinal(r: ClaudeAggregated): boolean {
  return (
    r.blocks.length === 1 &&
    r.blocks[0].type === "text" &&
    r.blocks[0].text === UPSTREAM_TRANSIENT_ERROR
  );
}

/**
 * Wraps execClaudeStreamJson with transparent retry on upstream transients.
 *
 * Strategy: a single `text` event whose body is exactly UPSTREAM_TRANSIENT_ERROR
 * is held back instead of forwarded immediately. If the stream then ends with
 * a `done` whose finalText is that same string (confirming it's the error and
 * nothing else), we discard everything and re-run the CLI. Successful streams
 * pass through unchanged — the only observed latency is for responses where
 * the model naturally opens with that exact string, which is vanishingly rare.
 *
 * After config.upstreamRetryMax attempts, we flush what we have and emit an
 * error event so callers can surface a 503.
 */
export function execClaudeStreamJsonWithRetry(
  prompt: string,
  onEvent: (event: ClaudeEvent) => void,
  systemPrompt?: string
): void {
  const maxAttempts = Math.max(1, config.upstreamRetryMax + 1);

  const attempt = (n: number) => {
    const buffered: ClaudeEvent[] = [];
    let sawNonErrorContent = false;
    let heldErrorText: { type: "text"; text: string } | null = null;

    const flushBuffered = () => {
      for (const e of buffered) onEvent(e);
      buffered.length = 0;
      if (heldErrorText) {
        onEvent(heldErrorText);
        heldErrorText = null;
      }
    };

    execClaudeStreamJson(
      prompt,
      (event) => {
        if (event.type === "tool_use") {
          sawNonErrorContent = true;
          flushBuffered();
          onEvent(event);
          return;
        }

        if (event.type === "text") {
          if (event.text === UPSTREAM_TRANSIENT_ERROR && !sawNonErrorContent) {
            // Hold — might be the transient. Don't forward yet.
            heldErrorText = event;
            return;
          }
          sawNonErrorContent = true;
          flushBuffered();
          onEvent(event);
          return;
        }

        if (event.type === "done") {
          const isTransient =
            !sawNonErrorContent &&
            heldErrorText !== null &&
            event.finalText === UPSTREAM_TRANSIENT_ERROR;

          if (isTransient && n < maxAttempts) {
            // Silent retry — client has seen nothing yet. Backoff ramps
            // because these rejections cluster near the 5-hour budget edge.
            const delayMs = 1000 * n + Math.floor(Math.random() * 500);
            setTimeout(() => attempt(n + 1), delayMs);
            return;
          }

          // Either success, or retries exhausted. Flush any held buffer.
          flushBuffered();
          onEvent(event);
          return;
        }

        if (event.type === "error") {
          flushBuffered();
          onEvent(event);
        }
      },
      systemPrompt
    );
  };

  attempt(1);
}

/**
 * Run claude CLI to completion and aggregate all text + tool_use events
 * into a single response. Uses the same stream-json parser as the streaming
 * path, so tool calls are preserved in the non-streaming response body.
 * Retries transparently on upstream transients.
 */
export function execClaudeAggregate(prompt: string, systemPrompt?: string): Promise<ClaudeAggregated> {
  return new Promise((resolve, reject) => {
    const blocks: ClaudeContentBlock[] = [];
    let stopReason: string | null = null;
    let finalText = "";
    let costUsd: number | undefined;
    let durationMs: number | undefined;

    execClaudeStreamJsonWithRetry(
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
