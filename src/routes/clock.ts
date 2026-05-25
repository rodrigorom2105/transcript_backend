import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '../middleware/auth';
import {
  recordClockEvent,
  getClockStatus,
  getClockHistory,
  ClockError,
} from '../services/clock';
import { logger } from '../utils/logger';

const clockBodySchema = z.object({
  discordUserId: z.string().min(1),
  displayName: z.string().min(1),
});

async function handleClockAction(
  action: 'CLOCKIN' | 'CLOCKOUT',
  app: FastifyInstance
) {
  app.post(`/clock/${action === 'CLOCKIN' ? 'in' : 'out'}`, { preHandler: requireInternalSecret }, async (req, reply) => {
    const parsed = clockBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }

    const { discordUserId, displayName } = parsed.data;

    try {
      const result = await recordClockEvent({ discordUserId, displayName, action });
      logger.info({ discordUserId, action, eventId: result.id, sheetsSynced: result.sheetsSynced }, 'clock event recorded');
      return reply.code(200).send({
        action: result.action,
        eventAt: result.eventAt.toISOString(),
        localTime: result.localTime,
        timezone: result.timezone,
        sheetsSynced: result.sheetsSynced,
      });
    } catch (err) {
      if (err instanceof ClockError) {
        return reply.code(409).send({
          error: err.code,
          lastAction: err.lastAction,
          lastAt: err.lastAt?.toISOString() ?? null,
        });
      }
      logger.error({ err, discordUserId, action }, 'Unexpected error recording clock event');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

export async function clockRoutes(app: FastifyInstance) {
  await handleClockAction('CLOCKIN', app);
  await handleClockAction('CLOCKOUT', app);

  app.get<{ Params: { discordUserId: string } }>(
    '/clock/status/:discordUserId',
    { preHandler: requireInternalSecret },
    async (req, reply) => {
      const { discordUserId } = req.params;
      const status = await getClockStatus(discordUserId);
      return reply.code(200).send({
        clockedIn: status.clockedIn,
        lastAction: status.lastAction,
        lastAt: status.lastAt?.toISOString() ?? null,
      });
    }
  );

  app.get<{
    Params: { discordUserId: string };
    Querystring: { limit?: string };
  }>(
    '/clock/history/:discordUserId',
    { preHandler: requireInternalSecret },
    async (req, reply) => {
      const { discordUserId } = req.params;
      const limit = parseInt(req.query.limit ?? '50', 10);
      const history = await getClockHistory(discordUserId, isNaN(limit) ? 50 : limit);
      return reply.code(200).send(
        history.map((e) => ({
          id: e.id,
          action: e.action,
          displayName: e.displayName,
          eventAt: e.eventAt.toISOString(),
          sheetsSynced: e.sheetsSynced,
        }))
      );
    }
  );
}
