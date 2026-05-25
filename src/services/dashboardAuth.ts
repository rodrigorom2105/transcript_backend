import jwt from 'jsonwebtoken';
import { db } from '../db/client';
import { config } from '../config';

export interface DashboardJWTPayload {
  sub: number;
  username: string;
  iat: number;
  exp: number;
}

export async function verifyCredentials(
  username: string,
  password: string
): Promise<{ id: number; username: string } | null> {
  const result = await db.query<{ id: number; username: string }>(
    `SELECT id, username FROM dashboard_users
     WHERE username = $1
       AND password_hash = crypt($2, password_hash)`,
    [username, password]
  );
  return result.rows[0] ?? null;
}

export function signDashboardJwt(payload: { sub: number; username: string }): string {
  const expiresIn = config.DASHBOARD_JWT_TTL_HOURS * 3600;
  return jwt.sign(payload, config.DASHBOARD_JWT_SECRET, { expiresIn });
}

export function verifyDashboardJwt(token: string): DashboardJWTPayload | null {
  try {
    return jwt.verify(token, config.DASHBOARD_JWT_SECRET) as unknown as DashboardJWTPayload;
  } catch {
    return null;
  }
}

export function dashboardTokenExpiresAt(ttlHours = config.DASHBOARD_JWT_TTL_HOURS): string {
  return new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
}
