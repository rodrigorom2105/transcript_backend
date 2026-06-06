import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireDashboardJwt } from '../middleware/auth';
import {
  verifyCredentials,
  signDashboardJwt,
  dashboardTokenExpiresAt,
} from '../services/dashboardAuth';
import { getDashboardSummary, getClockEvents } from '../services/clock';
import { logger } from '../utils/logger';

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const summaryQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

const eventsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  discordUserId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const MAX_RANGE_DAYS = 90;

export async function dashboardRoutes(app: FastifyInstance) {
  app.post(
    '/dashboard/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const parsed = loginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body' });
      }

      const { username, password } = parsed.data;
      const user = await verifyCredentials(username, password);

      if (!user) {
        logger.warn({ username }, 'Failed dashboard login attempt');
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      const token = signDashboardJwt({ sub: user.id, username: user.username });
      const expiresAt = dashboardTokenExpiresAt();

      logger.info({ username, userId: user.id }, 'Dashboard login successful');

      return reply.code(200).send({
        token,
        user: { id: user.id, username: user.username },
        expiresAt,
      });
    }
  );

  app.post('/dashboard/refresh', { preHandler: requireDashboardJwt }, async (req, reply) => {
    const { sub, username } = req.dashboardUser;
    const token = signDashboardJwt({ sub, username });
    const expiresAt = dashboardTokenExpiresAt();
    return reply.code(200).send({ token, expiresAt });
  });

  app.get<{ Querystring: Record<string, string> }>(
    '/dashboard/clock/summary',
    { preHandler: requireDashboardJwt },
    async (req, reply) => {
      const parsed = summaryQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid query params', detail: parsed.error.flatten() });
      }

      const from = new Date(parsed.data.from);
      const to = new Date(parsed.data.to);

      if (from >= to) {
        return reply.code(400).send({ error: '`from` must be before `to`' });
      }

      const rangeDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
      if (rangeDays > MAX_RANGE_DAYS) {
        return reply.code(400).send({ error: `Range cannot exceed ${MAX_RANGE_DAYS} days` });
      }

      try {
        const summary = await getDashboardSummary(from, to);
        return reply.code(200).send({
          range: {
            from: summary.range.from.toISOString(),
            to: summary.range.to.toISOString(),
          },
          agents: summary.agents.map((a) => ({
            discordUserId: a.discordUserId,
            displayName: a.displayName,
            totalMinutes: a.totalMinutes,
            shiftsCount: a.shiftsCount,
            currentlyClocked: a.currentlyClocked,
            shifts: a.shifts.map((s) => ({
              clockIn: s.clockIn.toISOString(),
              clockOut: s.clockOut?.toISOString() ?? null,
              durationMinutes: s.durationMinutes,
            })),
          })),
        });
      } catch (err) {
        logger.error({ err }, 'Error fetching dashboard summary');
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

  app.get<{ Querystring: Record<string, string> }>(
    '/dashboard/clock/events',
    { preHandler: requireDashboardJwt },
    async (req, reply) => {
      const parsed = eventsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid query params', detail: parsed.error.flatten() });
      }

      const { from: fromStr, to: toStr, discordUserId, limit, offset } = parsed.data;
      const from = new Date(fromStr);
      const to = new Date(toStr);

      if (from >= to) {
        return reply.code(400).send({ error: '`from` must be before `to`' });
      }

      const rangeDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
      if (rangeDays > MAX_RANGE_DAYS) {
        return reply.code(400).send({ error: `Range cannot exceed ${MAX_RANGE_DAYS} days` });
      }

      try {
        const page = await getClockEvents({ from, to, discordUserId, limit, offset });
        return reply.code(200).send({
          events: page.events.map((e) => ({
            id: e.id,
            discordUserId: e.discordUserId,
            displayName: e.displayName,
            action: e.action,
            eventAt: e.eventAt.toISOString(),
            sheetsSynced: e.sheetsSynced,
          })),
          total: page.total,
          limit: page.limit,
          offset: page.offset,
        });
      } catch (err) {
        logger.error({ err }, 'Error fetching clock events');
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );
}
