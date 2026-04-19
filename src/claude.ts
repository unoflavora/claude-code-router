import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "./config.js";

/**
 * Request-level overrides — values from the request body that win over
 * server-level config for a single call.
 */
export interface RequestOverrides {
  tools?: string[];
  model?: string;
  effort?: string;
}

/**
 * Tier preset → (model, effort). Applied when the client sends `tier` and
 * hasn't set `model`/`effort` explicitly. These aliases ride on top of the
 * CLI's own `sonnet`/`opus`/`haiku` shortcuts.
 */
const TIER_PRESETS: Record<string, { model: string; effort: string }> = {
  fast: { model: "haiku", effort: "low" },
  balanced: { model: "sonnet", effort: "medium" },
  deep: { model: "opus", effort: "high" },
};

/**
 * Resolve tier → concrete overrides, without clobbering explicit values.
 */
export function applyTierPreset(
  overrides: RequestOverrides | undefined,
  tier: string | undefined
): RequestOverrides | undefined {
  if (!tier) return overrides;
  const preset = TIER_PRESETS[tier.toLowerCase()];
  if (!preset) return overrides;
  const out: RequestOverrides = { ...(overrides ?? {}) };
  if (!out.model) out.model = preset.model;
  if (!out.effort) out.effort = preset.effort;
  return out;
}

/**
 * Given a list of fully-qualified tool names, return only the built-in tools
 * (anything not prefixed `mcp__` — MCP tools come via --mcp-config, not --tools).
 */
function builtInSubset(tools: string[]): string[] {
  return tools.filter((t) => !t.startsWith("mcp__"));
}

/**
 * Build the CLI args for `claude -p`.
 */
function buildArgs(prompt: string, systemPrompt?: string, overrides?: RequestOverrides): string[] {
  const args = ["-p", prompt];

  if (config.claudeMode === "lean") {
    args.push("--setting-sources", config.claudeSettingSources);
  }
  // "full" = no flags, load everything

  if (config.claudeSettings) {
    args.push("--settings", config.claudeSettings);
  }

  // MCP config is loaded unless per-request `tools` was given and contains no
  // mcp__* entries — that's how clients opt out of MCP for a particular call.
  const loadMcp =
    !!config.mcpConfig &&
    (overrides?.tools === undefined || overrides.tools.some((t) => t.startsWith("mcp__")));
  if (loadMcp) {
    args.push("--mcp-config", config.mcpConfig);
    if (config.strictMcpConfig) {
      args.push("--strict-mcp-config");
    }
  }

  // Per-request `tools` (from the request body) overrides both allowlist and
  // the --tools built-in filter. Unset = fall back to server-level config.
  if (overrides?.tools !== undefined) {
    args.push("--allowedTools", overrides.tools.join(" "));
    args.push("--tools", builtInSubset(overrides.tools).join(","));
  } else {
    if (config.allowedTools) {
      args.push("--allowedTools", config.allowedTools);
    }
    if (config.claudeTools !== "default") {
      // "" disables all built-ins; a name list keeps just those.
      args.push("--tools", config.claudeTools);
    }
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

  const model = overrides?.model || config.claudeModel;
  if (model) {
    args.push("--model", model);
  }

  const effort = overrides?.effort || config.claudeEffort;
  if (effort) {
    args.push("--effort", effort);
  }

  if (config.claudeFallbackModel) {
    args.push("--fallback-model", config.claudeFallbackModel);
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
 * Model aliases clients may always pass regardless of ALLOWED_MODELS.
 */
export const BUILT_IN_MODEL_ALIASES = ["sonnet", "opus", "haiku"] as const;

/**
 * Decide the effective request-level model given a client-provided name.
 * Returns undefined when the client didn't ask for one, or when the name is
 * not allowed (router-pinned model is used instead). Tier names are stripped
 * — those are handled via applyTierPreset.
 */
export function resolveRequestedModel(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const n = name.trim();
  // Clients often send the router's own model id — ignore (use server default).
  if (!n || n === "claude-code") return undefined;
  // Tier sugar — resolved elsewhere.
  if (n in TIER_PRESETS) return undefined;
  if ((BUILT_IN_MODEL_ALIASES as readonly string[]).includes(n)) return n;
  if (config.allowedModels.length === 0) return undefined;
  return config.allowedModels.includes(n) ? n : undefined;
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
  systemPrompt?: string,
  overrides?: RequestOverrides
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
      systemPrompt,
      overrides
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
export function execClaudeAggregate(
  prompt: string,
  systemPrompt?: string,
  overrides?: RequestOverrides
): Promise<ClaudeAggregated> {
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
      systemPrompt,
      overrides
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
  systemPrompt?: string,
  overrides?: RequestOverrides
): { proc: ChildProcessWithoutNullStreams } {
  const args = [...buildArgs(prompt, systemPrompt, overrides), "--output-format", "stream-json", "--verbose"];

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
