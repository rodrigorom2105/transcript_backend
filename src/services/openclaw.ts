import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface OpenClawMessage {
  role: 'system' | 'user';
  content: string;
}

export class OpenClawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenClawError';
  }
}

function normalizeSessionKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith('agent:')) return trimmed;
  return `agent:${config.OPENCLAW_AGENT_ID}:explicit:${trimmed}`;
}

export async function chatCompletion(params: {
  sessionKey: string;
  messages: OpenClawMessage[];
  user?: string;
}): Promise<string> {
  const { sessionKey, messages, user } = params;
  const model = config.OPENCLAW_MODEL ?? `openclaw/${config.OPENCLAW_AGENT_ID}`;
  const effectiveSessionKey = normalizeSessionKey(sessionKey);

  let data: unknown;
  const t0 = Date.now();
  try {
    const res = await axios.post(
      `${config.OPENCLAW_URL}/v1/chat/completions`,
      {
        model,
        messages,
        stream: false,
        user,
        tool_choice: 'none',
        extra_body: { agent: { mode: 'chat' } },
      },
      {
        timeout: config.OPENCLAW_REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${config.OPENCLAW_GATEWAY_TOKEN}`,
          'Content-Type': 'application/json',
          'x-openclaw-agent-id': config.OPENCLAW_AGENT_ID,
          'x-openclaw-message-channel': 'discord',
          'x-openclaw-session-key': effectiveSessionKey,
        },
      }
    );
    data = res.data;
    logger.info({ ms: Date.now() - t0, model }, 'openclaw request completed');
  } catch (err: unknown) {
    const ms = Date.now() - t0;
    if (axios.isAxiosError(err) && err.response) {
      logger.warn({ ms, status: err.response.status }, 'openclaw request failed');
      throw new OpenClawError(
        `OpenClaw HTTP ${err.response.status}: ${String(err.response.data ?? err.response.statusText)}`
      );
    }
    logger.warn({ ms, err: String(err) }, 'openclaw request errored');
    throw new OpenClawError(`No se pudo contactar a OpenClaw: ${String(err)}`);
  }

  try {
    const answer = (data as { choices: { message: { content: string } }[] })
      .choices[0].message.content.trim();
    if (!answer) throw new Error('empty content');
    return answer;
  } catch {
    throw new OpenClawError(`Respuesta inesperada de OpenClaw: ${JSON.stringify(data)}`);
  }
}
