import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { stream as honoStream } from "hono/streaming";
import { execClaude, execClaudeStreamJson } from "../claude.js";
import { openaiToPrompt, type OpenAIChatRequest } from "../convert.js";

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
              stream.write("data: [DONE]\n\n");
              resolve();
            } else if (event.type === "error") {
              writeChunk({ content: `\n\nError: ${event.message}` }, "stop");
              stream.write("data: [DONE]\n\n");
              resolve();
            }
          },
          systemPrompt
        );
      });
    });
  }

  // Non-streaming
  const result = await execClaude(prompt, systemPrompt);

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
          content: result.text,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
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
