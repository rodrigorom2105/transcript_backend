import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exchangeCode, isMember } from '../services/discord';
import { signJwt } from '../services/jwt';
import { db } from '../db/client';
import { logger } from '../utils/logger';

const bodySchema = z.object({ code: z.string().min(1) });

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/discord', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Missing or invalid code' });
    }

    let discordUser: { id: string; username: string; avatar: string | null };
    let guilds: { id: string }[];

    try {
      const result = await exchangeCode(parsed.data.code);
      discordUser = result.user;
      guilds = result.guilds;
    } catch (err) {
      logger.error({ err }, 'Discord OAuth exchange failed');
      return reply.code(500).send({ error: 'Discord API error' });
    }

    if (!isMember(guilds)) {
      return reply.code(403).send({ error: 'Not a guild member' });
    }

    await db.query(
      `INSERT INTO users (discord_user_id, username, avatar, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (discord_user_id) DO UPDATE
         SET username = EXCLUDED.username,
             avatar   = EXCLUDED.avatar,
             updated_at = NOW()`,
      [discordUser.id, discordUser.username, discordUser.avatar]
    );

    const jwtToken = signJwt({
      discordUserId: discordUser.id,
      agentName: discordUser.username,
      avatar: discordUser.avatar,
    });

    logger.info({ discordUserId: discordUser.id }, 'agent authenticated');

    return reply.code(200).send({
      jwt: jwtToken,
      user: {
        id: discordUser.id,
        username: discordUser.username,
        avatar: discordUser.avatar,
      },
    });
  });
}
