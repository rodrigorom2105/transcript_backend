import { db } from '../db/client';
import { gptChatCompletion } from '../services/gpt';
import { chatCompletion } from '../services/openclaw';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { CopilotSignal, CopilotSuggestion } from './types';
import { buildCopilotContext } from './contextBuilder';

async function persistGptRequestLog(params: {
  sessionId: string;
  suggestionId: number | null;
  provider: CopilotSuggestion['source'];
  model: string | null;
  triggerType: CopilotSignal['type'];
  stage: string;
  systemPrompt: string;
  userPrompt: string;
  transcriptExcerpt: string;
  responseText: string | null;
  error: string | null;
  latencyMs: number;
}) {
  try {
    await db.query(
      `INSERT INTO copilot_gpt_request_logs
       (session_id, suggestion_id, provider, model, trigger_type, stage, system_prompt,
        user_prompt, transcript_excerpt, response_text, error, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        params.sessionId,
        params.suggestionId,
        params.provider,
        params.model,
        params.triggerType,
        params.stage,
        params.systemPrompt,
        params.userPrompt,
        params.transcriptExcerpt,
        params.responseText,
        params.error,
        params.latencyMs,
      ]
    );
  } catch (err) {
    logger.warn({ err, sessionId: params.sessionId }, 'could not persist copilot GPT request log');
  }
}

export async function generateCopilotSuggestion(params: {
  sessionId: string;
  discordUserId: string;
  signal: CopilotSignal;
}): Promise<CopilotSuggestion> {
  const context = await buildCopilotContext({
    sessionId: params.sessionId,
    signal: params.signal,
  });

  let text: string;
  let source: CopilotSuggestion['source'];
  let model: string | null;
  const requestStartedAt = Date.now();

  try {
    if (config.COPILOT_PROVIDER === 'openclaw') {
      text = await chatCompletion({
        sessionKey: `call:${params.sessionId}`,
        messages: [
          { role: 'system', content: context.systemPrompt },
          { role: 'user', content: context.userPrompt },
        ],
        user: params.discordUserId,
      });
      source = 'openclaw';
      model = config.OPENCLAW_MODEL ?? null;
    } else if (config.COPILOT_PROVIDER === 'playbook_only') {
      text = 'Para asegurarme de darle una recomendación correcta, ¿qué parte le gustaría aclarar primero: costo, beneficios o cómo funciona la póliza?';
      source = 'playbook';
      model = null;
    } else {
      text = await gptChatCompletion({
        messages: [
          { role: 'system', content: context.systemPrompt },
          { role: 'user', content: context.userPrompt },
        ],
        user: params.discordUserId,
      });
      source = 'gpt_api';
      model = config.GPT_MODEL;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    await persistGptRequestLog({
      sessionId: params.sessionId,
      suggestionId: null,
      provider: config.COPILOT_PROVIDER === 'openclaw' ? 'openclaw' : 'gpt_api',
      model: config.COPILOT_PROVIDER === 'openclaw' ? config.OPENCLAW_MODEL ?? null : config.GPT_MODEL,
      triggerType: params.signal.type,
      stage: context.stage,
      systemPrompt: context.systemPrompt,
      userPrompt: context.userPrompt,
      transcriptExcerpt: context.transcriptExcerpt,
      responseText: null,
      error: message,
      latencyMs: Date.now() - requestStartedAt,
    });
    throw err;
  }

  const normalized = text.replace(/^[']|[']$/g, '').replace(/^["]|["]$/g, '').trim();

  let id: number | null = null;
  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO copilot_suggestions
       (session_id, trigger_type, stage, matched_keywords, transcript_excerpt, suggestion, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        params.sessionId,
        params.signal.type,
        context.stage,
        params.signal.matchedKeywords,
        context.transcriptExcerpt,
        normalized,
        source,
      ]
    );
    id = rows[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err, sessionId: params.sessionId }, 'could not persist copilot suggestion');
  }

  await persistGptRequestLog({
    sessionId: params.sessionId,
    suggestionId: id,
    provider: source,
    model,
    triggerType: params.signal.type,
    stage: context.stage,
    systemPrompt: context.systemPrompt,
    userPrompt: context.userPrompt,
    transcriptExcerpt: context.transcriptExcerpt,
    responseText: normalized,
    error: null,
    latencyMs: Date.now() - requestStartedAt,
  });

  return {
    id,
    sessionId: params.sessionId,
    triggerType: params.signal.type,
    stage: context.stage,
    matchedKeywords: params.signal.matchedKeywords,
    text: normalized,
    source,
  };
}
