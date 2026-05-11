import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { JWTPayload } from '../types';

const EXPIRY_SECONDS = 50400; // 14 horas

export function signJwt(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: EXPIRY_SECONDS });
}

export function verifyJwt(token: string): JWTPayload {
  return jwt.verify(token, config.JWT_SECRET) as JWTPayload;
}
