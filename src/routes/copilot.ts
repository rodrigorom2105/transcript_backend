import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireJwt } from '../middleware/auth';
import { db } from '../db/client';
import { getSessionOwner } from '../services/sessions';
import { getCallStage } from '../copilot/stageDetector';
import { generateCopilotSuggestion } from '../copilot/recommendationService';
import type { CopilotSignal } from '../copilot/types';
import { logger } from '../utils/logger';

const feedbackSchema = z.object({
  accepted: z.boolean(),
});

export async function copilotRoutes(app: FastifyInstance) {
  app.get('/sessions/:id/copilot/state', { preHandler: requireJwt }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = await getSessionOwner(id);
    if (!owner) return reply.code(404).send({ error: 'Session not found' });
    if (owner !== req.user.discordUserId) return reply.code(403).send({ error: 'Forbidden' });

    const stage = await getCallStage(id);
    return reply.code(200).send({ stage });
  });

  app.post('/sessions/:id/copilot/suggest', { preHandler: requireJwt }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = await getSessionOwner(id);
    if (!owner) return reply.code(404).send({ error: 'Session not found' });
    if (owner !== req.user.discordUserId) return reply.code(403).send({ error: 'Forbidden' });

    const stage = await getCallStage(id);
    const signal: CopilotSignal = {
      type: 'manual_request',
      confidence: 1,
      reason: 'El agente pidió manualmente una recomendación.',
      matchedKeywords: [],
      stage,
    };

    try {
      const suggestion = await generateCopilotSuggestion({
        sessionId: id,
        discordUserId: req.user.discordUserId,
        signal,
      });
      return reply.code(200).send({ suggestion });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      const isInvalidApiKey = message.toLowerCase().includes('incorrect api key');
      logger.error(
        {
          sessionId: id,
          error: isInvalidApiKey ? 'invalid_openai_api_key' : message || 'unknown_error',
        },
        'copilot suggestion failed'
      );
      return reply.code(503).send({
        error: isInvalidApiKey ? 'invalid_openai_api_key' : 'copilot_unavailable',
      });
    }
  });

  app.post('/copilot/suggestions/:id/feedback', { preHandler: requireJwt }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body' });

    const { rows } = await db.query<{ session_id: string }>(
      `SELECT session_id FROM copilot_suggestions WHERE id = $1`,
      [id]
    );
    const sessionId = rows[0]?.session_id;
    if (!sessionId) return reply.code(404).send({ error: 'Suggestion not found' });

    const owner = await getSessionOwner(sessionId);
    if (owner !== req.user.discordUserId) return reply.code(403).send({ error: 'Forbidden' });

    await db.query(`UPDATE copilot_suggestions SET accepted = $1 WHERE id = $2`, [
      parsed.data.accepted,
      id,
    ]);

    return reply.code(200).send({});
  });
}
