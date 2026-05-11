import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt } from '../services/jwt';
import { config } from '../config';

export async function requireJwt(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const token = header.slice(7);
  try {
    req.user = verifyJwt(token);
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

export async function requireInternalSecret(req: FastifyRequest, reply: FastifyReply) {
  const secret = req.headers['x-internal-secret'];
  if (secret !== config.INTERNAL_SECRET) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}
