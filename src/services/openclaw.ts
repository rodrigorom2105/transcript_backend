import axios from 'axios';
import { config } from '../config';

// TODO: Reemplazar con el contrato real de OpenClaw cuando se conozca.
// La firma de esta función NO debe cambiar — las rutas dependen de ella.
// Actualmente asume POST {prompt: string} → {answer: string}.
// Ajustar la ruta, el request body y el response parsing según la API real.
export async function ask(prompt: string): Promise<string> {
  const res = await axios.post<{ answer: string }>(
    `${config.OPENCLAW_URL}/ask`,
    { prompt },
    { timeout: 15000 }
  );
  return res.data.answer;
}
