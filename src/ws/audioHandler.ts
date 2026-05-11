import type { FastifyInstance } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import { verifyJwt } from '../services/jwt';
import { redis } from '../redis/client';
import { activeSessionKey, endSession, pushTurn } from '../services/sessions';
import { createDeepgramSession } from '../services/deepgram';
import { logger } from '../utils/logger';

const SILENCE_TIMEOUT_MS = 60_000;

export async function audioHandler(app: FastifyInstance) {
  app.get('/audio', { websocket: true }, (connection: SocketStream, req) => {
    const socket = connection.socket;
    const url = new URL(req.url!, `http://localhost`);
    const sessionId = url.searchParams.get('sessionId');
    const token = url.searchParams.get('token');

    if (!sessionId || !token) {
      socket.close(4001, 'Unauthorized');
      return;
    }

    // Narrow to non-null for use in closures
    const sid: string = sessionId;

    let jwtPayload: ReturnType<typeof verifyJwt>;
    try {
      jwtPayload = verifyJwt(token);
    } catch {
      socket.close(4001, 'Unauthorized');
      return;
    }

    const { discordUserId } = jwtPayload;

    // Validate session ownership asynchronously then set up the session
    void (async () => {
      const activeSession = await redis.get(activeSessionKey(discordUserId));
      if (activeSession !== sid) {
        socket.close(4003, 'Session not found');
        return;
      }

      logger.info({ sessionId: sid, discordUserId }, 'WebSocket audio connected');

      let silenceTimer: NodeJS.Timeout | null = null;
      let closed = false;

      function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(async () => {
          if (closed) return;
          logger.warn({ sessionId: sid }, 'silence timeout — auto-ending session');
          closed = true;
          try {
            await endSession(sid, discordUserId);
          } catch (err) {
            logger.error({ err }, 'error ending session on silence timeout');
          }
          socket.close(1001, 'Silence timeout');
        }, SILENCE_TIMEOUT_MS);
      }

      const deepgram = createDeepgramSession(
        async (turn) => {
          logger.info({ sessionId: sid, speaker: turn.speaker, channel: turn.channel }, 'transcript turn');
          try {
            await pushTurn(sid, turn);
          } catch (err) {
            logger.error({ err }, 'error saving transcript turn');
          }
        },
        (err) => {
          logger.error({ err, sessionId: sid }, 'Deepgram error');
          if (!closed) {
            closed = true;
            socket.close(1011, 'Deepgram error');
          }
        }
      );

      resetSilenceTimer();

      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          resetSilenceTimer();
          try {
            deepgram.send(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
          } catch (err) {
            logger.error({ err }, 'error sending data to Deepgram');
          }
          return;
        }

        try {
          const msg = JSON.parse(data.toString()) as { type?: string };
          if (msg.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          // ignore malformed text frames
        }
      });

      socket.on('close', (code) => {
        if (silenceTimer) clearTimeout(silenceTimer);
        closed = true;
        deepgram.finish();
        logger.info({ sessionId: sid, code }, 'WebSocket closed');
        // Code 1000 = intentional; session cleanup done via POST /sessions/:id/end
      });

      socket.on('error', (err) => {
        logger.error({ err, sessionId: sid }, 'WebSocket error');
      });
    })();
  });
}
