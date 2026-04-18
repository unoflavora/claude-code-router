import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { stream as honoStream } from "hono/streaming";
import { execClaude, execClaudeStream } from "../claude.js";
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
      await new Promise<void>((resolve, reject) => {
        execClaudeStream(
          prompt,
          (delta) => {
            const chunk = {
              id: requestId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: delta },
                  finish_reason: null,
                },
              ],
            };
            stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
          },
          (_fullText) => {
            const done = {
              id: requestId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            stream.write(`data: ${JSON.stringify(done)}\n\n`);
            stream.write("data: [DONE]\n\n");
            resolve();
          },
          (err) => {
            const errChunk = {
              id: requestId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: `\n\nError: ${err.message}` },
                  finish_reason: "stop",
                },
              ],
            };
            stream.write(`data: ${JSON.stringify(errChunk)}\n\n`);
            stream.write("data: [DONE]\n\n");
            resolve();
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
