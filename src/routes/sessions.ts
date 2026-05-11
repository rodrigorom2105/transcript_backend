import type { FastifyInstance } from 'fastify';
import { requireJwt } from '../middleware/auth';
import { createSession, endSession, getSessionOwner } from '../services/sessions';
import { logger } from '../utils/logger';

export async function sessionRoutes(app: FastifyInstance) {
  app.post('/sessions', { preHandler: requireJwt }, async (req, reply) => {
    const { discordUserId, agentName } = req.user;
    const sessionId = await createSession(discordUserId, agentName);
    return reply.code(201).send({ sessionId });
  });

  app.post('/sessions/:id/end', { preHandler: requireJwt }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { discordUserId } = req.user;

    const owner = await getSessionOwner(id);
    if (!owner) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    if (owner !== discordUserId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    await endSession(id, discordUserId);
    logger.info({ sessionId: id, discordUserId }, 'session ended via API');

    return reply.code(200).send({});
  });
}
