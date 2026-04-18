import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { stream as honoStream } from "hono/streaming";
import { execClaude, execClaudeStream } from "../claude.js";
import { anthropicToPrompt, type AnthropicMessagesRequest } from "../convert.js";

const anthropic = new Hono();

anthropic.post("/v1/messages", async (c) => {
  const body = (await c.req.json()) as AnthropicMessagesRequest;
  const { prompt, systemPrompt } = anthropicToPrompt(body);
  const requestId = `msg_${uuidv4()}`;
  const model = body.model || "claude-code";

  if (body.stream) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return honoStream(c, async (stream) => {
      stream.write(`event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { id: requestId, type: "message", role: "assistant", content: [], model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
      })}\n\n`);

      stream.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`);

      await new Promise<void>((resolve) => {
        execClaudeStream(
          prompt,
          (delta) => {
            stream.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta },
            })}\n\n`);
          },
          (fullText) => {
            stream.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
            stream.write(`event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: fullText.length },
            })}\n\n`);
            stream.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            resolve();
          },
          (err) => {
            stream.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: `\n\nError: ${err.message}` },
            })}\n\n`);
            stream.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
            stream.write(`event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 0 },
            })}\n\n`);
            stream.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            resolve();
          },
          systemPrompt,
        );
      });
    });
  }

  const result = await execClaude(prompt, systemPrompt);

  return c.json({
    id: requestId,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: result.text }],
    model,
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  });
});

export { anthropic };
