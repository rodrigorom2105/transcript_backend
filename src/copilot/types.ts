import type { TranscriptTurn } from '../types';

export type CallStage =
  | 'idle'
  | 'opening'
  | 'discovery'
  | 'presentation'
  | 'objection_handling'
  | 'closing'
  | 'follow_up'
  | 'ended';

export interface CopilotSignal {
  type:
    | 'objection_detected'
    | 'risk_detected'
    | 'closing_opportunity'
    | 'customer_confused'
    | 'agent_stuck'
    | 'manual_request';
  confidence: number;
  reason: string;
  matchedKeywords: string[];
  stage: CallStage;
  turn?: TranscriptTurn;
}

export interface CopilotSuggestion {
  id: number | null;
  sessionId: string;
  triggerType: CopilotSignal['type'];
  stage: CallStage;
  matchedKeywords: string[];
  text: string;
  source: 'gpt_api' | 'openclaw' | 'playbook';
}
