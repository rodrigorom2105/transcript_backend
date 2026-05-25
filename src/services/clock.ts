import { db } from '../db/client';
import { appendClockRow } from './sheets';
import { formatInTimezone } from '../utils/time';
import { config } from '../config';
import { logger } from '../utils/logger';

export type ClockAction = 'CLOCKIN' | 'CLOCKOUT';

export class ClockError extends Error {
  constructor(
    public readonly code: 'already_clocked_in' | 'not_clocked_in',
    public readonly lastAction: ClockAction | null,
    public readonly lastAt: Date | null
  ) {
    super(code);
    this.name = 'ClockError';
  }
}

export interface ClockResult {
  id: number;
  action: ClockAction;
  eventAt: Date;
  localTime: string;
  timezone: string;
  sheetsSynced: boolean;
}

export async function recordClockEvent(opts: {
  discordUserId: string;
  displayName: string;
  action: ClockAction;
}): Promise<ClockResult> {
  const { discordUserId, displayName, action } = opts;

  const client = await db.connect();
  let eventId: number;
  let eventAt: Date;

  try {
    await client.query('BEGIN');

    // Serialize concurrent requests for the same agent using an advisory lock.
    // hashtext() maps the userId string to a 32-bit int — good enough for per-agent locking.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [discordUserId]);

    const lastRow = await client.query<{ action: ClockAction; event_at: Date }>(
      `SELECT action, event_at FROM clock_events
       WHERE discord_user_id = $1
       ORDER BY event_at DESC
       LIMIT 1`,
      [discordUserId]
    );

    const last = lastRow.rows[0] ?? null;

    if (action === 'CLOCKIN' && last?.action === 'CLOCKIN') {
      throw new ClockError('already_clocked_in', last.action, last.event_at);
    }
    if (action === 'CLOCKOUT' && last?.action !== 'CLOCKIN') {
      throw new ClockError('not_clocked_in', last?.action ?? null, last?.event_at ?? null);
    }

    const inserted = await client.query<{ id: number; event_at: Date }>(
      `INSERT INTO clock_events (discord_user_id, display_name, action)
       VALUES ($1, $2, $3)
       RETURNING id, event_at`,
      [discordUserId, displayName, action]
    );

    eventId = inserted.rows[0].id;
    eventAt = inserted.rows[0].event_at;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { time: localTime } = formatInTimezone(eventAt, config.CLOCK_TIMEZONE);

  let sheetsSynced = false;
  try {
    await appendClockRow({ discordUserId, displayName, action, eventAt });
    await db.query(`UPDATE clock_events SET sheets_synced = TRUE WHERE id = $1`, [eventId]);
    sheetsSynced = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, eventId, discordUserId }, 'Failed to sync clock event to Google Sheets');
    await db.query(
      `UPDATE clock_events SET sheets_error = $1 WHERE id = $2`,
      [message, eventId]
    );
  }

  return {
    id: eventId,
    action,
    eventAt,
    localTime,
    timezone: config.CLOCK_TIMEZONE,
    sheetsSynced,
  };
}

export interface ClockStatus {
  clockedIn: boolean;
  lastAction: ClockAction | null;
  lastAt: Date | null;
}

export async function getClockStatus(discordUserId: string): Promise<ClockStatus> {
  const result = await db.query<{ action: ClockAction; event_at: Date }>(
    `SELECT action, event_at FROM clock_events
     WHERE discord_user_id = $1
     ORDER BY event_at DESC
     LIMIT 1`,
    [discordUserId]
  );

  if (result.rows.length === 0) {
    return { clockedIn: false, lastAction: null, lastAt: null };
  }

  const { action, event_at } = result.rows[0];
  return {
    clockedIn: action === 'CLOCKIN',
    lastAction: action,
    lastAt: event_at,
  };
}

export interface ClockHistoryEntry {
  id: number;
  action: ClockAction;
  displayName: string;
  eventAt: Date;
  sheetsSynced: boolean;
}

export async function getClockHistory(
  discordUserId: string,
  limit: number
): Promise<ClockHistoryEntry[]> {
  const clamped = Math.min(Math.max(limit, 1), 200);
  const result = await db.query<{
    id: number;
    action: ClockAction;
    display_name: string;
    event_at: Date;
    sheets_synced: boolean;
  }>(
    `SELECT id, action, display_name, event_at, sheets_synced
     FROM clock_events
     WHERE discord_user_id = $1
     ORDER BY event_at DESC
     LIMIT $2`,
    [discordUserId, clamped]
  );

  return result.rows.map((r) => ({
    id: r.id,
    action: r.action,
    displayName: r.display_name,
    eventAt: r.event_at,
    sheetsSynced: r.sheets_synced,
  }));
}
