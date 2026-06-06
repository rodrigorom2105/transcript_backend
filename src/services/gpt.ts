import { config } from '../config';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export async function gptChatCompletion(params: {
  messages: ChatMessage[];
  user?: string;
  timeoutMs?: number;
}): Promise<string> {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? config.GPT_REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.GPT_MODEL,
        messages: params.messages,
        temperature: 0.3,
        max_tokens: 120,
        user: params.user,
      }),
    });

    const body = (await response.json()) as ChatCompletionResponse;
    if (!response.ok) {
      throw new Error(body.error?.message ?? `OpenAI HTTP ${response.status}`);
    }

    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('OpenAI returned an empty response');
    return content;
  } finally {
    clearTimeout(timeout);
  }
}
