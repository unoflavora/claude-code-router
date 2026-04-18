/**
 * Convert between OpenAI and Anthropic message formats,
 * and flatten them into a single prompt string for `claude -p`.
 */

// --- OpenAI types ---

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAIContentPart[];
}

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

// --- Anthropic types ---

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: "text" | "image";
  text?: string;
  source?: { type: string; media_type: string; data: string };
}

export interface AnthropicMessagesRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

// --- Converters ---

/**
 * Extract system prompt and flatten messages into a single prompt string.
 */
export function openaiToPrompt(req: OpenAIChatRequest): { prompt: string; systemPrompt?: string } {
  let systemPrompt: string | undefined;
  const parts: string[] = [];

  for (const msg of req.messages) {
    const text = typeof msg.content === "string"
      ? msg.content
      : msg.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");

    if (msg.role === "system") {
      systemPrompt = text;
    } else {
      parts.push(`${msg.role}: ${text}`);
    }
  }

  // If only one user message and no conversation history, send raw content
  const userMessages = req.messages.filter((m) => m.role === "user");
  if (userMessages.length === 1 && req.messages.filter((m) => m.role === "assistant").length === 0) {
    const text = typeof userMessages[0].content === "string"
      ? userMessages[0].content
      : userMessages[0].content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
    return { prompt: text, systemPrompt };
  }

  return { prompt: parts.join("\n\n"), systemPrompt };
}

export function anthropicToPrompt(req: AnthropicMessagesRequest): { prompt: string; systemPrompt?: string } {
  const systemPrompt = req.system || undefined;
  const parts: string[] = [];

  for (const msg of req.messages) {
    const text = typeof msg.content === "string"
      ? msg.content
      : msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
    parts.push(`${msg.role}: ${text}`);
  }

  // If only one user message, send raw content
  const userMessages = req.messages.filter((m) => m.role === "user");
  if (userMessages.length === 1 && req.messages.filter((m) => m.role === "assistant").length === 0) {
    const text = typeof userMessages[0].content === "string"
      ? userMessages[0].content
      : userMessages[0].content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
    return { prompt: text, systemPrompt };
  }

  return { prompt: parts.join("\n\n"), systemPrompt };
}
