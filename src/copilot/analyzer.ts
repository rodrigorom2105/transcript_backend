import type { TranscriptTurn } from '../types';
import { findMatches, keywordGroups } from './keywords';
import type { CopilotSignal } from './types';
import { updateCallStageFromTurn } from './stageDetector';

export async function analyzeTurn(
  sessionId: string,
  turn: TranscriptTurn
): Promise<{ signal: CopilotSignal | null; stageChanged: boolean; stage: CopilotSignal['stage'] }> {
  const stageResult = await updateCallStageFromTurn(sessionId, turn);
  const stage = stageResult.next;

  // Automatic recommendations are intentionally conservative in MVP.
  // Only the call stage is emitted automatically; suggestions remain manual.
  const objectionMatches = findMatches(turn.text, keywordGroups.objections);
  if (turn.speaker === 'cliente' && objectionMatches.length > 0) {
    return {
      stageChanged: stageResult.changed,
      stage,
      signal: {
        type: 'objection_detected',
        confidence: 0.82,
        reason: `Objeción detectada: ${objectionMatches.join(', ')}`,
        matchedKeywords: objectionMatches,
        stage,
        turn,
      },
    };
  }

  const riskMatches = findMatches(turn.text, keywordGroups.risk);
  if (riskMatches.length > 0) {
    return {
      stageChanged: stageResult.changed,
      stage,
      signal: {
        type: 'risk_detected',
        confidence: 0.78,
        reason: `Riesgo de compliance detectado: ${riskMatches.join(', ')}`,
        matchedKeywords: riskMatches,
        stage,
        turn,
      },
    };
  }

  const closingMatches = findMatches(turn.text, keywordGroups.closing);
  if (turn.speaker === 'cliente' && closingMatches.length > 0) {
    return {
      stageChanged: stageResult.changed,
      stage,
      signal: {
        type: 'closing_opportunity',
        confidence: 0.74,
        reason: `Oportunidad de cierre detectada: ${closingMatches.join(', ')}`,
        matchedKeywords: closingMatches,
        stage,
        turn,
      },
    };
  }

  return { signal: null, stageChanged: stageResult.changed, stage };
}
