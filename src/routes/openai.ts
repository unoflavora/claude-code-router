import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { stream as honoStream } from "hono/streaming";
import { execClaudeAggregate, execClaudeStreamJson } from "../claude.js";
import { openaiToPrompt, type OpenAIChatRequest } from "../convert.js";
import { config } from "../config.js";

const MODEL_NAME = "claude-code";

const openai = new Hono();

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint.
 */
openai.post("/v1/chat/completions", async (c) => {
  const body = (await c.req.json()) as OpenAIChatRequest;
  const { prompt, systemPrompt } = openaiToPrompt(body);
  const requestId = `chatcmpl-${uuidv4()}`;
  const model = body.model || MODEL_NAME;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return honoStream(c, async (stream) => {
      await new Promise<void>((resolve) => {
        let toolCallIndex = 0;
        const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
          const chunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          };
          stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
        };

        const heartbeat = config.sseHeartbeatMs > 0
          ? setInterval(() => void stream.write(": heartbeat\n\n"), config.sseHeartbeatMs)
          : null;
        const finish = () => {
          if (heartbeat) clearInterval(heartbeat);
          stream.write("data: [DONE]\n\n");
          resolve();
        };

        execClaudeStreamJson(
          prompt,
          (event) => {
            if (event.type === "text") {
              writeChunk({ content: event.text });
            } else if (event.type === "tool_use") {
              writeChunk({
                tool_calls: [
                  {
                    index: toolCallIndex++,
                    id: event.id,
                    type: "function",
                    function: {
                      name: event.name,
                      arguments: JSON.stringify(event.input ?? {}),
                    },
                  },
                ],
              });
            } else if (event.type === "done") {
              writeChunk({}, "stop");
              finish();
            } else if (event.type === "error") {
              writeChunk({ content: `\n\nError: ${event.message}` }, "stop");
              finish();
            }
          },
          systemPrompt
        );
      });
    });
  }

  // Non-streaming — aggregate text + tool_use from stream-json events.
  const result = await execClaudeAggregate(prompt, systemPrompt);

  const content = result.blocks
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const toolCalls = result.blocks
    .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
    .map((b, index) => ({
      index,
      id: b.id,
      type: "function" as const,
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));

  return c.json({
    id: requestId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
});

/**
 * GET /v1/models
 * List available models.
 */
openai.get("/v1/models", (c) => {
  return c.json({
    object: "list",
    data: [
      {
        id: MODEL_NAME,
        object: "model",
        created: 1700000000,
        owned_by: "claude-code-router",
      },
    ],
  });
});

export { openai };
