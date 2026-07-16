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

function extractMarkdownSection(markdown: string, headingIncludes: string): string {
  const escaped = headingIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingMatch = markdown.match(new RegExp(`^#{2,3} .*${escaped}.*$`, 'm'));
  if (!headingMatch || headingMatch.index === undefined) return '';

  const start = headingMatch.index;
  const headingLevel = headingMatch[0].match(/^#+/)?.[0].length ?? 2;
  const nextHeading = markdown
    .slice(start + headingMatch[0].length)
    .search(new RegExp(`\\n#{1,${headingLevel}} `));
  const end = nextHeading === -1
    ? undefined
    : start + headingMatch[0].length + nextHeading;

  return markdown.slice(start, end).trim();
}

function extractSections(markdown: string, headings: string[]): string {
  return headings
    .map((heading) => extractMarkdownSection(markdown, heading))
    .filter(Boolean)
    .join('\n\n---\n\n')
    .trim();
}

function selectOperatingGuidance(stage: CallStage): string {
  const profile = readPlaybook('sales-operating-profile.md');
  if (!profile) return '';

  const common = extractSections(profile, [
    'Rol central del Co-Pilot',
    'Personalidad del Co-Pilot',
    'Reglas de comportamiento en tiempo real',
    'Framework de llamada',
  ]);

  const stageHeadingsByStage: Partial<Record<CallStage, string[]>> = {
    opening: ['Etapa opening'],
    discovery: ['Etapa discovery'],
    presentation: ['Etapa presentation'],
    objection_handling: ['Etapa objection_handling', 'Manejo de desviaciones del guion'],
    closing: ['Etapa closing'],
    follow_up: ['Etapa follow_up', 'Manejo de desviaciones del guion'],
    idle: ['Prompt maestro'],
    ended: ['Principios finales'],
  };

  const stageSpecific = extractSections(profile, stageHeadingsByStage[stage] ?? []);
  const checklist = extractMarkdownSection(profile, 'Checklist de avance por etapa');
  const responseFormat = extractMarkdownSection(profile, 'Formato ideal de respuesta');
  const principles = extractMarkdownSection(profile, 'Principios finales');

  return [common, stageSpecific, checklist, responseFormat, principles]
    .filter(Boolean)
    .join('\n\n---\n\n')
    .trim();
}

export async function buildCopilotContext(params: {
  sessionId: string;
  signal: CopilotSignal;
}): Promise<{ systemPrompt: string; userPrompt: string; transcriptExcerpt: string; stage: CallStage }> {
  const stage = await getCallStage(params.sessionId);
  const turns = await getRecentTurns(params.sessionId, RECENT_WINDOW_MS);
  const transcriptExcerpt = formatTurns(turns) || '(sin transcript disponible)';

  const operatingGuidance = selectOperatingGuidance(stage).slice(0, 5200);

  const systemPrompt = `Eres el IUL Sales Co-Pilot para un agente humano en una llamada de venta en tiempo real.
Tu funcion es sugerir UNA frase lista para decir que mantenga control, profundice necesidad, maneje objeciones y avance hacia la aplicacion.

Mindset:
- No eres un bot informativo; eres un asistente de cierre.
- Se servicial, estrategico, sharp, empatico y firme con elegancia.
- El cliente no necesita informacion generica; necesita descubrir si esta herramienta resuelve la razon por la que pidio ayuda.
- Valida al cliente sin ceder el control de la llamada.
- Si el cliente pregunta fuera de tiempo, valida, responde breve y regresa con una pregunta estrategica.
- No permitas avanzar sin un why claro.
- Despues de explicar el producto, empuja la auto-venta: que el cliente diga como el IUL lo podria beneficiar.
- Despues de la auto-venta, usa pullback real: no toda persona califica por edad, salud, presupuesto y aprobacion.
- Antes de cerrar, ayuda a contrastar el futuro con y sin accion, y transiciona a la aplicacion como siguiente paso natural para revisar si califica.

Limites:
- Responde en espanol latino natural.
- Maximo 1 a 3 frases cortas.
- No uses metacomentarios como "puedes decir", "te sugiero", "diagnostico" o "intencion".
- No inventes datos que no esten en el contexto.
- No prometas rendimientos, aprobacion, cobertura, beneficios ni resultados garantizados.
- No presentes IUL como inversion pura, inversion garantizada o sin riesgo.
- La salida debe ser solo la frase para decir al cliente.`;

const userPrompt = `[ESTADO DE LA LLAMADA]
Etapa: ${stage}
Señal: ${params.signal.type}
Motivo: ${params.signal.reason}
Keywords: ${params.signal.matchedKeywords.join(', ') || '(ninguna)'}

[TRANSCRIPT RECIENTE]
${transcriptExcerpt}

[FUENTE OPERATIVA UNICA]
${operatingGuidance || '(sin perfil operativo disponible)'}

Usa exclusivamente la fuente operativa anterior, la etapa detectada y el transcript reciente para decidir que debe hacer el agente ahora.
Genera solo UNA frase lista para decir al cliente.`;

  return { systemPrompt, userPrompt, transcriptExcerpt, stage };
}
