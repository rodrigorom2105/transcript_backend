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

export interface ShiftEntry {
  clockIn: Date;
  clockOut: Date | null;
  durationMinutes: number | null;
}

export interface AgentSummary {
  discordUserId: string;
  displayName: string;
  totalMinutes: number;
  shiftsCount: number;
  currentlyClocked: boolean;
  shifts: ShiftEntry[];
}

export interface DashboardSummary {
  range: { from: Date; to: Date };
  agents: AgentSummary[];
}

export async function getDashboardSummary(from: Date, to: Date): Promise<DashboardSummary> {
  type ShiftJSON = { clockIn: string; clockOut: string | null; durationMinutes: number | null };
  const result = await db.query<{
    discord_user_id: string;
    display_name: string;
    total_minutes: number;
    shifts_count: number;
    currently_clocked: boolean;
    shifts: ShiftJSON[];
  }>(
    `WITH ordered AS (
       SELECT discord_user_id, display_name, action, event_at,
              LEAD(action)   OVER w AS next_action,
              LEAD(event_at) OVER w AS next_event_at
       FROM clock_events
       WHERE event_at <= $2
       WINDOW w AS (PARTITION BY discord_user_id ORDER BY event_at)
     ),
     shifts AS (
       SELECT discord_user_id, display_name,
              event_at AS clock_in,
              CASE WHEN next_action = 'CLOCKOUT' THEN next_event_at END AS clock_out
       FROM ordered
       WHERE action = 'CLOCKIN'
         AND (next_event_at IS NULL OR next_event_at >= $1)
     ),
     clipped AS (
       SELECT discord_user_id, display_name,
              GREATEST(clock_in, $1::timestamptz)                                          AS clock_in_clipped,
              LEAST(COALESCE(clock_out, NOW()), $2::timestamptz)                           AS clock_out_clipped,
              clock_in, clock_out
       FROM shifts
     ),
     last_evt AS (
       SELECT DISTINCT ON (discord_user_id)
              discord_user_id, action AS last_action
       FROM clock_events
       ORDER BY discord_user_id, event_at DESC
     )
     SELECT c.discord_user_id,
            c.display_name,
            SUM(EXTRACT(EPOCH FROM (c.clock_out_clipped - c.clock_in_clipped)) / 60)::int AS total_minutes,
            COUNT(*)::int                                                                   AS shifts_count,
            COALESCE((l.last_action = 'CLOCKIN'), false)                                   AS currently_clocked,
            json_agg(
              json_build_object(
                'clockIn',  c.clock_in,
                'clockOut', c.clock_out,
                'durationMinutes', CASE
                  WHEN c.clock_out IS NULL THEN NULL
                  ELSE (EXTRACT(EPOCH FROM (c.clock_out - c.clock_in)) / 60)::int
                END
              ) ORDER BY c.clock_in
            ) AS shifts
     FROM clipped c
     LEFT JOIN last_evt l USING (discord_user_id)
     GROUP BY c.discord_user_id, c.display_name, l.last_action
     ORDER BY total_minutes DESC`,
    [from.toISOString(), to.toISOString()]
  );

  return {
    range: { from, to },
    agents: result.rows.map((r) => ({
      discordUserId: r.discord_user_id,
      displayName: r.display_name,
      totalMinutes: r.total_minutes,
      shiftsCount: r.shifts_count,
      currentlyClocked: r.currently_clocked,
      shifts: r.shifts.map((s) => ({
        clockIn: new Date(s.clockIn),
        clockOut: s.clockOut ? new Date(s.clockOut) : null,
        durationMinutes: s.durationMinutes,
      })),
    })),
  };
}

export interface ClockEventRow {
  id: number;
  discordUserId: string;
  displayName: string;
  action: ClockAction;
  eventAt: Date;
  sheetsSynced: boolean;
}

export interface ClockEventsPage {
  events: ClockEventRow[];
  total: number;
  limit: number;
  offset: number;
}

export async function getClockEvents(opts: {
  from: Date;
  to: Date;
  discordUserId?: string;
  limit: number;
  offset: number;
}): Promise<ClockEventsPage> {
  const { from, to, discordUserId, limit, offset } = opts;
  const clamped = Math.min(Math.max(limit, 1), 500);

  const conditions: string[] = ['event_at >= $1', 'event_at <= $2'];
  const params: unknown[] = [from.toISOString(), to.toISOString()];

  if (discordUserId) {
    params.push(discordUserId);
    conditions.push(`discord_user_id = $${params.length}`);
  }

  const where = conditions.join(' AND ');

  params.push(clamped, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const result = await db.query<{
    id: number;
    discord_user_id: string;
    display_name: string;
    action: ClockAction;
    event_at: Date;
    sheets_synced: boolean;
    total_count: string;
  }>(
    `SELECT id, discord_user_id, display_name, action, event_at, sheets_synced,
            COUNT(*) OVER () AS total_count
     FROM clock_events
     WHERE ${where}
     ORDER BY event_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;

  return {
    events: result.rows.map((r) => ({
      id: r.id,
      discordUserId: r.discord_user_id,
      displayName: r.display_name,
      action: r.action,
      eventAt: r.event_at,
      sheetsSynced: r.sheets_synced,
    })),
    total,
    limit: clamped,
    offset,
  };
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
