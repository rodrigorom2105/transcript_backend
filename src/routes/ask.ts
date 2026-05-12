import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '../middleware/auth';
import { redis } from '../redis/client';
import { activeSessionKey, getRecentTurns } from '../services/sessions';
import { ask as openclawAsk } from '../services/openclaw';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import type { TranscriptTurn } from '../types';

const bodySchema = z.object({
  discordUserId: z.string().min(1),
  question: z.string().min(1),
});

function formatTurns(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => {
      const d = new Date(t.timestamp);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${t.speaker} (${hh}:${mm}:${ss}): ${t.text}`;
    })
    .join('\n');
}

function buildPrompt(turns: TranscriptTurn[], question: string): string {
  return `[INSTRUCCIONES DEL SISTEMA]
Eres asistente de un agente de ventas de seguros IUL (Indexed Universal Life).
Recibes el contexto reciente de una conversación entre el agente y su cliente,
y una pregunta del agente sobre cómo responder.

Tu tarea: dar UNA SOLA FRASE que el agente pueda repetir tal cual al cliente.

Reglas:
- Máximo 2 oraciones, lenguaje natural y conversacional
- Español neutro con tono cálido y profesional
- No uses jerga técnica salvo que el cliente ya la haya usado
- NUNCA prometas rendimientos garantizados (regulación de seguros)
- Si el contexto es insuficiente, pide UNA aclaración corta
- No incluyas preámbulos como "podrías decir" o "te sugiero"

Formato de salida: solo la frase, directo, lista para leer en voz alta.

[TRANSCRIPT RECIENTE - últimos 5 minutos]
${formatTurns(turns) || '(sin transcript disponible)'}

[PREGUNTA DEL AGENTE]
${question}`;
}

export async function askRoutes(app: FastifyInstance) {
  app.get<{ Params: { discordUserId: string } }>(
    '/status/:discordUserId',
    { preHandler: requireInternalSecret },
    async (req, reply) => {
      const { discordUserId } = req.params;

      const sessionId = await redis.get(activeSessionKey(discordUserId));
      if (!sessionId) {
        return reply.code(200).send({ active: false });
      }

      const result = await db.query<{ started_at: Date }>(
        `SELECT started_at FROM sessions WHERE id = $1`,
        [sessionId]
      );

      if (result.rows.length === 0) {
        return reply.code(200).send({ active: false });
      }

      return reply.code(200).send({
        active: true,
        sessionId,
        startedAt: result.rows[0].started_at.toISOString(),
      });
    }
  );

  app.post('/ask', { preHandler: requireInternalSecret }, async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }

    const { discordUserId, question } = parsed.data;

    const sessionId = await redis.get(activeSessionKey(discordUserId));
    if (!sessionId) {
      return reply.code(404).send({ error: 'no_active_session' });
    }

    const turns = await getRecentTurns(sessionId);
    const prompt = buildPrompt(turns, question);

    let answer: string;
    try {
      answer = await openclawAsk(prompt);
    } catch (err) {
      logger.error({ err }, 'OpenClaw request failed');
      return reply.code(503).send({ error: 'llm_unavailable' });
    }

    await db.query(
      `INSERT INTO questions (session_id, question, answer) VALUES ($1, $2, $3)`,
      [sessionId, question, answer]
    );

    logger.info({ sessionId, discordUserId }, 'question answered');
    return reply.code(200).send({ answer });
  });
}
