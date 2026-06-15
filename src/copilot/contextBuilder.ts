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

function extractScriptSection(script: string, headingIncludes: string): string {
  const headingMatch = script.match(new RegExp(`^## .*${headingIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm'));
  if (!headingMatch || headingMatch.index === undefined) return '';

  const start = headingMatch.index;
  const next = script.indexOf('\n## ', start + headingMatch[0].length);
  return script.slice(start, next === -1 ? undefined : next).trim();
}

function selectScriptSection(stage: CallStage): string {
  const script = readPlaybook('iul-script.md');
  if (!script) return '';

  const headingsByStage: Partial<Record<CallStage, string[]>> = {
    opening: ['Paso 1: Introducción Confiada', 'Paso 2: Identificación y Credibilidad'],
    discovery: ['Paso 4: Fact-Finding y Cierre'],
    presentation: ['Paso 3: Explicación del IUL - Lo Básico', 'Beneficios Clave de la IUL', 'Resumen Final de Beneficios'],
    objection_handling: ['Pullback - Psicología Inversa', 'Paso 4: Fact-Finding y Cierre'],
    closing: ['Cierre Final - Sin Presión', 'APLICACIÓN'],
    follow_up: ['Cierre Final con el Cliente', 'Pasos para Firmar NLG'],
  };

  const headings = headingsByStage[stage];
  if (!headings) return '';

  const sections = headings
    .map((heading) => extractScriptSection(script, heading))
    .filter(Boolean);

  return sections.join('\n\n---\n\n').trim();
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
