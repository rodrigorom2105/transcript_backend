import type { TranscriptTurn } from '../types';
import { redis } from '../redis/client';
import { findMatches, keywordGroups } from './keywords';
import type { CallStage } from './types';

export function copilotStateKey(sessionId: string) {
  return `session:${sessionId}:copilot_state`;
}

interface StoredCopilotState {
  stage: CallStage;
  updatedAt: number;
}

const STAGE_PRIORITY: Record<CallStage, number> = {
  idle: 0,
  opening: 1,
  discovery: 2,
  presentation: 3,
  objection_handling: 4,
  closing: 5,
  follow_up: 6,
  ended: 7,
};

export async function getCallStage(sessionId: string): Promise<CallStage> {
  const raw = await redis.get(copilotStateKey(sessionId));
  if (!raw) return 'idle';
  try {
    return (JSON.parse(raw) as StoredCopilotState).stage ?? 'idle';
  } catch {
    return 'idle';
  }
}

export async function setCallStage(sessionId: string, stage: CallStage): Promise<void> {
  const state: StoredCopilotState = { stage, updatedAt: Date.now() };
  await redis.set(copilotStateKey(sessionId), JSON.stringify(state), 'EX', 3600);
}

export function detectStageFromTurn(turn: TranscriptTurn, current: CallStage): CallStage {
  const text = turn.text;

  if (findMatches(text, keywordGroups.followUp).length > 0) return 'follow_up';
  if (findMatches(text, keywordGroups.closing).length > 0) return 'closing';
  if (findMatches(text, keywordGroups.objections).length > 0) return 'objection_handling';
  if (findMatches(text, keywordGroups.product).length > 0) return 'presentation';
  if (findMatches(text, keywordGroups.discovery).length > 0) return 'discovery';
  if (current === 'idle' && findMatches(text, keywordGroups.opening).length > 0) return 'opening';

  return current === 'idle' ? 'opening' : current;
}

export async function updateCallStageFromTurn(
  sessionId: string,
  turn: TranscriptTurn
): Promise<{ previous: CallStage; next: CallStage; changed: boolean }> {
  const previous = await getCallStage(sessionId);
  const detected = detectStageFromTurn(turn, previous);

  // Avoid moving backwards in normal flow, except objections can happen from any stage.
  const next = detected === 'objection_handling' || STAGE_PRIORITY[detected] >= STAGE_PRIORITY[previous]
    ? detected
    : previous;

  if (next !== previous) {
    await setCallStage(sessionId, next);
  }

  return { previous, next, changed: next !== previous };
}
