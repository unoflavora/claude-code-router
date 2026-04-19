import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { stream as honoStream } from "hono/streaming";
import {
  execClaudeAggregate,
  execClaudeStreamJsonWithRetry,
  isUpstreamTransientFinal,
  applyTierPreset,
  resolveRequestedModel,
  type RequestOverrides,
} from "../claude.js";
import { anthropicToPrompt, extractToolNames, type AnthropicMessagesRequest } from "../convert.js";
import { config } from "../config.js";

const anthropic = new Hono();

anthropic.post("/v1/messages", async (c) => {
  const body = (await c.req.json()) as AnthropicMessagesRequest;
  const { prompt, systemPrompt } = anthropicToPrompt(body);
  const tools = extractToolNames(body);
  let overrides: RequestOverrides | undefined;
  if (tools !== undefined) overrides = { ...(overrides ?? {}), tools };
  const m = resolveRequestedModel(body.model);
  if (m) overrides = { ...(overrides ?? {}), model: m };
  if (body.effort) overrides = { ...(overrides ?? {}), effort: body.effort };
  overrides = applyTierPreset(overrides, body.tier);
  const requestId = `msg_${uuidv4()}`;
  const model = body.model || "claude-code";

  if (body.stream) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return honoStream(c, async (stream) => {
      const writeEvent = (event: string, data: unknown) => {
        stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      writeEvent("message_start", {
        type: "message_start",
        message: {
          id: requestId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      const heartbeat = config.sseHeartbeatMs > 0
        ? setInterval(() => writeEvent("ping", { type: "ping" }), config.sseHeartbeatMs)
        : null;

      // Track which block index we're in and whether it's open.
      let blockIndex = -1;
      let openBlockType: "text" | "tool_use" | null = null;

      const closeOpenBlock = () => {
        if (openBlockType !== null) {
          writeEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
          openBlockType = null;
        }
      };

      await new Promise<void>((resolve) => {
        execClaudeStreamJsonWithRetry(
          prompt,
          (event) => {
            if (event.type === "text") {
              if (openBlockType !== "text") {
                closeOpenBlock();
                blockIndex++;
                openBlockType = "text";
                writeEvent("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "text", text: "" },
                });
              }
              writeEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "text_delta", text: event.text },
              });
            } else if (event.type === "tool_use") {
              closeOpenBlock();
              blockIndex++;
              openBlockType = "tool_use";
              writeEvent("content_block_start", {
                type: "content_block_start",
                index: blockIndex,
                content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
              });
              writeEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(event.input ?? {}) },
              });
              closeOpenBlock();
            } else if (event.type === "done") {
              closeOpenBlock();
              writeEvent("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: event.finalText.length },
              });
              writeEvent("message_stop", { type: "message_stop" });
              if (heartbeat) clearInterval(heartbeat);
              resolve();
            } else if (event.type === "error") {
              if (openBlockType !== "text") {
                closeOpenBlock();
                blockIndex++;
                openBlockType = "text";
                writeEvent("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "text", text: "" },
                });
              }
              writeEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "text_delta", text: `\n\nError: ${event.message}` },
              });
              closeOpenBlock();
              writeEvent("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 0 },
              });
              writeEvent("message_stop", { type: "message_stop" });
              if (heartbeat) clearInterval(heartbeat);
              resolve();
            }
          },
          systemPrompt,
          overrides
        );
      });
    });
  }

  // Non-streaming — aggregate all events into Anthropic content blocks.
  const result = await execClaudeAggregate(prompt, systemPrompt, overrides);

  if (isUpstreamTransientFinal(result)) {
    c.header("Retry-After", "30");
    return c.json(
      {
        type: "error",
        error: {
          type: "overloaded_error",
          message:
            "Upstream Anthropic rejected the request (likely org 5-hour budget exhausted). Retry later.",
        },
      },
      503
    );
  }

  const content = result.blocks.map((b) =>
    b.type === "text"
      ? { type: "text" as const, text: b.text }
      : { type: "tool_use" as const, id: b.id, name: b.name, input: b.input }
  );

  // stop_reason is always "end_turn": tool calls are resolved server-side by the
  // CLI, so tool_use blocks here are informational and the client shouldn't
  // try to round-trip them.
  return c.json({
    id: requestId,
    type: "message",
    role: "assistant",
    content: content.length ? content : [{ type: "text", text: "" }],
    model,
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  });
});

export { anthropic };
