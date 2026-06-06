import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptTurn } from '../types';
import { getRecentTurns } from '../services/sessions';
import { getCallStage } from './stageDetector';
import type { CallStage, CopilotSignal } from './types';

const RECENT_WINDOW_MS = Number(process.env.COPILOT_RECENT_WINDOW_MS ?? 180_000);
const MAX_TURNS = 16;

function readPlaybook(filename: string): string {
  const candidates = [
    path.join(__dirname, 'playbooks', filename),
    path.join(process.cwd(), 'src', 'copilot', 'playbooks', filename),
  ];

  for (const filePath of candidates) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      // try next candidate
    }
  }

  return '';
}

function formatTurns(turns: TranscriptTurn[]): string {
  return turns
    .slice(-MAX_TURNS)
    .map((t) => {
      const d = new Date(t.timestamp);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${t.speaker} (${hh}:${mm}:${ss}): ${t.text}`;
    })
    .join('\n');
}

function selectScriptSection(stage: CallStage): string {
  const script = readPlaybook('iul-script.md');
  if (!script) return '';

  const sectionByStage: Partial<Record<CallStage, string>> = {
    opening: '## Apertura',
    discovery: '## Descubrimiento',
    presentation: '## Presentación breve',
    objection_handling: '## Descubrimiento',
    closing: '## Cierre suave',
    follow_up: '## Cierre suave',
  };

  const marker = sectionByStage[stage];
  if (!marker) return script.slice(0, 1200);

  const start = script.indexOf(marker);
  if (start === -1) return script.slice(0, 1200);
  const next = script.indexOf('\n## ', start + marker.length);
  return script.slice(start, next === -1 ? undefined : next).trim();
}

export async function buildCopilotContext(params: {
  sessionId: string;
  signal: CopilotSignal;
}): Promise<{ systemPrompt: string; userPrompt: string; transcriptExcerpt: string; stage: CallStage }> {
  const stage = await getCallStage(params.sessionId);
  const turns = await getRecentTurns(params.sessionId, RECENT_WINDOW_MS);
  const transcriptExcerpt = formatTurns(turns) || '(sin transcript disponible)';

  const compliance = readPlaybook('compliance-rules.md').slice(0, 1600);
  const faq = readPlaybook('product-faq.md').slice(0, 1400);
  const script = selectScriptSection(stage).slice(0, 1200);

  const systemPrompt = `Eres un copilot silencioso para un agente humano que vende seguros IUL.\nTu tarea es sugerir UNA frase breve que el agente pueda decir al cliente.\n\nReglas:\n- Responde en español neutro.\n- Máximo 2 frases.\n- No uses metacomentarios como "puedes decir" o "te sugiero".\n- No inventes datos que no estén en el contexto.\n- No prometas rendimientos garantizados.\n- No presentes IUL como inversión garantizada o sin riesgo.\n- Si falta contexto, sugiere una pregunta aclaratoria breve.\n- La salida debe ser solo la frase para decir al cliente.`;

  const userPrompt = `[ESTADO DE LA LLAMADA]\nEtapa: ${stage}\nSeñal: ${params.signal.type}\nMotivo: ${params.signal.reason}\nKeywords: ${params.signal.matchedKeywords.join(', ') || '(ninguna)'}\n\n[TRANSCRIPT RECIENTE]\n${transcriptExcerpt}\n\n[GUION RELEVANTE]\n${script || '(sin guion disponible)'}\n\n[FAQ PRODUCTO]\n${faq || '(sin FAQ disponible)'}\n\n[REGLAS DE COMPLIANCE]\n${compliance || '(sin reglas disponibles)'}\n\nGenera solo la frase que debería decir el agente al cliente ahora.`;

  return { systemPrompt, userPrompt, transcriptExcerpt, stage };
}
