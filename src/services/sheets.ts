import * as fs from 'fs';
import { google } from 'googleapis';
import { config } from '../config';
import { formatInTimezone } from '../utils/time';

type SheetsClient = ReturnType<typeof google.sheets>;

let cachedClient: SheetsClient | null = null;

function getClient(): SheetsClient {
  if (cachedClient) return cachedClient;

  const keyFile = config.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credentials = JSON.parse(fs.readFileSync(keyFile, 'utf8'));

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  cachedClient = google.sheets({ version: 'v4', auth });
  return cachedClient;
}

const verifiedTabs = new Set<string>();

function sanitizeTabName(displayName: string, discordUserId: string): string {
  const safe = displayName.replace(/[\[\]*?/\\]/g, '').trim() || 'Agente';
  const suffix = discordUserId.slice(-6);
  const trimmed = safe.slice(0, 94); // max sheet name = 100 chars
  return `${trimmed}_${suffix}`;
}

async function ensureSheet(sheets: SheetsClient, tabName: string): Promise<void> {
  if (verifiedTabs.has(tabName)) return;

  const spreadsheetId = config.GOOGLE_SHEETS_SPREADSHEET_ID;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1:C1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Fecha', 'Hora', 'Acción']] },
    });
  }

  verifiedTabs.add(tabName);
}

export interface AppendClockRowOpts {
  discordUserId: string;
  displayName: string;
  action: 'CLOCKIN' | 'CLOCKOUT';
  eventAt: Date;
}

export async function appendClockRow(opts: AppendClockRowOpts): Promise<void> {
  const { discordUserId, displayName, action, eventAt } = opts;
  const sheets = getClient();
  const tabName = sanitizeTabName(displayName, discordUserId);

  await ensureSheet(sheets, tabName);

  const { date, time } = formatInTimezone(eventAt, config.CLOCK_TIMEZONE);

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `'${tabName}'!A:C`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[date, time, action]] },
  });
}
