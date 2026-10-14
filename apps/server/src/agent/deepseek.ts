const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export type DeepSeekRole = "system" | "user" | "assistant" | "tool";

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekMessage {
  role: DeepSeekRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
}

export interface DeepSeekToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: DeepSeekMessage;
    finish_reason: string;
  }>;
}

export async function createChatCompletion(input: {
  messages: DeepSeekMessage[];
  tools?: DeepSeekToolDefinition[];
}): Promise<DeepSeekMessage> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY. Configure it in apps/server/.env.");
  }

  const timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || "20000");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
        messages: input.messages,
        tools: input.tools,
        stream: false
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`DeepSeek API timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const message = data.choices.at(0)?.message;
  if (!message) {
    throw new Error("DeepSeek API did not return a message.");
  }

  return message;
}
