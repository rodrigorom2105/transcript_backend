import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { redis } from '../redis/client';
import type { TranscriptTurn } from '../types';
import { logger } from '../utils/logger';

export function transcriptKey(sessionId: string) {
  return `session:${sessionId}:transcript`;
}

export function activeSessionKey(discordUserId: string) {
  return `agent:${discordUserId}:active_session`;
}

export async function closeActiveSession(discordUserId: string) {
  const existingId = await redis.get(activeSessionKey(discordUserId));
  if (!existingId) return;

  await endSession(existingId, discordUserId);
}

export async function createSession(discordUserId: string, agentName: string): Promise<string> {
  await closeActiveSession(discordUserId);

  const sessionId = uuidv4();

  await db.query(
    `INSERT INTO sessions (id, discord_user_id, agent_name, status)
     VALUES ($1, $2, $3, 'active')`,
    [sessionId, discordUserId, agentName]
  );

  await redis.set(activeSessionKey(discordUserId), sessionId);

  logger.info({ sessionId, discordUserId }, 'session created');
  return sessionId;
}

export async function endSession(sessionId: string, discordUserId: string) {
  await db.query(
    `UPDATE sessions SET status = 'ended', ended_at = NOW()
     WHERE id = $1 AND discord_user_id = $2`,
    [sessionId, discordUserId]
  );

  const rawTurns = await redis.lrange(transcriptKey(sessionId), 0, -1);
  if (rawTurns.length > 0) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const raw of rawTurns) {
        const turn: TranscriptTurn = JSON.parse(raw);
        await client.query(
          `INSERT INTO transcript_turns (session_id, speaker, channel, text, ts)
           VALUES ($1, $2, $3, $4, $5)`,
          [sessionId, turn.speaker, turn.channel, turn.text, turn.timestamp]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  await redis.del(transcriptKey(sessionId));
  await redis.del(activeSessionKey(discordUserId));

  logger.info({ sessionId, discordUserId, turns: rawTurns.length }, 'session ended');
}

export async function getSessionOwner(sessionId: string): Promise<string | null> {
  const { rows } = await db.query<{ discord_user_id: string }>(
    'SELECT discord_user_id FROM sessions WHERE id = $1 AND status = $2',
    [sessionId, 'active']
  );
  return rows[0]?.discord_user_id ?? null;
}

export async function getRecentTurns(sessionId: string, windowMs = 5 * 60 * 1000): Promise<TranscriptTurn[]> {
  const cutoff = Date.now() - windowMs;
  const rawTurns = await redis.lrange(transcriptKey(sessionId), 0, -1);
  return rawTurns
    .map((r) => JSON.parse(r) as TranscriptTurn)
    .filter((t) => t.timestamp >= cutoff);
}

export async function pushTurn(sessionId: string, turn: TranscriptTurn) {
  await redis.rpush(transcriptKey(sessionId), JSON.stringify(turn));
  await redis.expire(transcriptKey(sessionId), 3600);
}
