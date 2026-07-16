import { db } from '../db/client';

export type BillingPeriod = 'once' | 'month' | 'year';
export type SignatureStatus = 'IMM' | 'UW' | 'DATE';

export class SalesError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'SalesError';
  }
}

export interface CreateSaleInput {
  discordInteractionId?: string | null;
  discordMessageId?: string | null;
  discordGuildId?: string | null;
  discordChannelId?: string | null;
  agentDiscordUserId: string;
  agentDisplayName: string;
  companyCode: string;
  productCode: string;
  clientName: string;
  amount: number;
  currency?: string;
  billingPeriod: BillingPeriod;
  signatureInput: string;
  rawText?: string | null;
  soldAt?: Date | null;
  notes?: string | null;
}

export interface UpdateSaleInput {
  companyCode?: string;
  productCode?: string;
  clientName?: string;
  amount?: number;
  currency?: string;
  billingPeriod?: BillingPeriod;
  signatureInput?: string;
  soldAt?: Date;
  notes?: string | null;
}

export interface SaleRow {
  id: number;
  discordInteractionId: string | null;
  discordMessageId: string | null;
  discordGuildId: string | null;
  discordChannelId: string | null;
  agentDiscordUserId: string;
  agentDisplayName: string;
  companyCode: string;
  companyName: string;
  productCode: string;
  productName: string;
  clientName: string;
  amountCents: number;
  currency: string;
  billingPeriod: BillingPeriod;
  signatureStatus: SignatureStatus;
  signatureDate: Date | null;
  followupCode: string | null;
  rawText: string | null;
  notes: string | null;
  soldAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

type SaleDbRow = {
  id: number;
  discord_interaction_id: string | null;
  discord_message_id: string | null;
  discord_guild_id: string | null;
  discord_channel_id: string | null;
  agent_discord_user_id: string;
  agent_display_name: string;
  company_code: string;
  company_name: string;
  product_code: string;
  product_name: string;
  client_name: string;
  amount_cents: number;
  currency: string;
  billing_period: BillingPeriod;
  signature_status: SignatureStatus;
  signature_date: Date | null;
  followup_code: string | null;
  raw_text: string | null;
  notes: string | null;
  sold_at: Date;
  created_at: Date;
  updated_at: Date;
};

const saleSelect = `
  s.id, s.discord_interaction_id, s.discord_message_id, s.discord_guild_id, s.discord_channel_id,
  s.agent_discord_user_id, s.agent_display_name,
  c.code AS company_code, c.name AS company_name,
  p.code AS product_code, p.name AS product_name,
  s.client_name, s.amount_cents, s.currency, s.billing_period,
  s.signature_status, s.signature_date, s.followup_code,
  s.raw_text, s.notes, s.sold_at, s.created_at, s.updated_at
`;

function mapSale(row: SaleDbRow): SaleRow {
  return {
    id: row.id,
    discordInteractionId: row.discord_interaction_id,
    discordMessageId: row.discord_message_id,
    discordGuildId: row.discord_guild_id,
    discordChannelId: row.discord_channel_id,
    agentDiscordUserId: row.agent_discord_user_id,
    agentDisplayName: row.agent_display_name,
    companyCode: row.company_code,
    companyName: row.company_name,
    productCode: row.product_code,
    productName: row.product_name,
    clientName: row.client_name,
    amountCents: row.amount_cents,
    currency: row.currency,
    billingPeriod: row.billing_period,
    signatureStatus: row.signature_status,
    signatureDate: row.signature_date,
    followupCode: row.followup_code,
    rawText: row.raw_text,
    notes: row.notes,
    soldAt: row.sold_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeRequiredCode(value: string, errorCode: string): string {
  const normalized = normalizeCode(value);
  if (!normalized) throw new SalesError(errorCode);
  return normalized;
}

function amountToCents(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) throw new SalesError('invalid_amount');
  return Math.round(amount * 100);
}

function parseSignature(input: string): { status: SignatureStatus; date: string | null; followupCode: string | null } {
  const value = input.trim().toUpperCase();
  if (value === 'IMM' || value === 'UW') return { status: value, date: null, followupCode: value };

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return { status: 'DATE', date: value, followupCode: null };
  }

  const mxMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mxMatch) {
    const [, dd, mm, yyyy] = mxMatch;
    const normalized = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const date = new Date(`${normalized}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return { status: 'DATE', date: normalized, followupCode: null };
  }

  throw new SalesError('invalid_signature_input');
}

async function resolveCatalog(companyCode: string, productCode: string): Promise<{ companyId: number; productId: number }> {
  const company = normalizeRequiredCode(companyCode, 'invalid_company');
  const product = normalizeRequiredCode(productCode, 'invalid_product');

  const companyResult = await db.query<{ id: number }>(
    `INSERT INTO sales_companies (code, name, active)
     VALUES ($1, $1, TRUE)
     ON CONFLICT (code) DO UPDATE
     SET name = EXCLUDED.name,
         active = TRUE
     RETURNING id`,
    [company]
  );
  const companyId = companyResult.rows[0].id;

  const productResult = await db.query<{ id: number }>(
    `INSERT INTO sales_products (company_id, code, name, active)
     VALUES ($1, $2, $2, TRUE)
     ON CONFLICT (company_id, code) DO UPDATE
     SET name = EXCLUDED.name,
         active = TRUE
     RETURNING id`,
    [companyId, product]
  );

  return { companyId, productId: productResult.rows[0].id };
}

export async function getSalesCatalog() {
  const companies = await db.query<{
    id: number;
    code: string;
    name: string;
    products: { id: number; code: string; name: string }[];
  }>(
    `SELECT c.id, c.code, c.name,
            COALESCE(json_agg(json_build_object('id', p.id, 'code', p.code, 'name', p.name) ORDER BY p.code)
              FILTER (WHERE p.id IS NOT NULL), '[]') AS products
     FROM sales_companies c
     LEFT JOIN sales_products p ON p.company_id = c.id AND p.active = TRUE
     WHERE c.active = TRUE
     GROUP BY c.id, c.code, c.name
     ORDER BY c.code`
  );
  const followupCodes = await db.query<{ code: string; label: string }>(
    `SELECT code, label FROM sales_followup_codes WHERE active = TRUE ORDER BY code`
  );
  return { companies: companies.rows, followupCodes: followupCodes.rows };
}

export async function createSale(input: CreateSaleInput): Promise<SaleRow> {
  const amountCents = amountToCents(input.amount);
  const { status, date, followupCode } = parseSignature(input.signatureInput);
  const { companyId, productId } = await resolveCatalog(input.companyCode, input.productCode);
  const clientName = input.clientName.trim();
  if (!clientName) throw new SalesError('invalid_client_name');

  try {
    const result = await db.query<SaleDbRow>(
      `INSERT INTO sales (
         discord_interaction_id, discord_message_id, discord_guild_id, discord_channel_id,
         agent_discord_user_id, agent_display_name, company_id, product_id, client_name,
         amount_cents, currency, billing_period, signature_status, signature_date,
         followup_code, raw_text, notes, sold_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18, NOW()))
       RETURNING id`,
      [
        input.discordInteractionId ?? null,
        input.discordMessageId ?? null,
        input.discordGuildId ?? null,
        input.discordChannelId ?? null,
        input.agentDiscordUserId,
        input.agentDisplayName.trim(),
        companyId,
        productId,
        clientName,
        amountCents,
        (input.currency ?? 'USD').trim().toUpperCase(),
        input.billingPeriod,
        status,
        date,
        followupCode,
        input.rawText ?? null,
        input.notes ?? null,
        input.soldAt?.toISOString() ?? null,
      ]
    );

    return await getSaleById(result.rows[0].id);
  } catch (err: any) {
    if (err?.code === '23505') throw new SalesError('duplicate_sale');
    throw err;
  }
}

export async function getSaleById(id: number): Promise<SaleRow> {
  const result = await db.query<SaleDbRow>(
    `SELECT ${saleSelect}
     FROM sales s
     JOIN sales_companies c ON c.id = s.company_id
     JOIN sales_products p ON p.id = s.product_id
     WHERE s.id = $1`,
    [id]
  );
  if (!result.rows[0]) throw new SalesError('sale_not_found');
  return mapSale(result.rows[0]);
}

export interface SalesFilters {
  from: Date;
  to: Date;
  company?: string;
  product?: string;
  agentDiscordUserId?: string;
}

function buildWhere(filters: SalesFilters): { where: string; params: unknown[] } {
  const conditions = ['s.sold_at >= $1', 's.sold_at < $2'];
  const params: unknown[] = [filters.from.toISOString(), filters.to.toISOString()];
  if (filters.company) {
    params.push(normalizeCode(filters.company));
    conditions.push(`c.code = $${params.length}`);
  }
  if (filters.product) {
    params.push(normalizeCode(filters.product));
    conditions.push(`p.code = $${params.length}`);
  }
  if (filters.agentDiscordUserId) {
    params.push(filters.agentDiscordUserId);
    conditions.push(`s.agent_discord_user_id = $${params.length}`);
  }
  return { where: conditions.join(' AND '), params };
}

export async function getSalesSummary(filters: SalesFilters) {
  const { where, params } = buildWhere(filters);
  const totals = await db.query<{
    sales_count: number;
    total_amount_cents: number | null;
    average_ticket_cents: number | null;
    active_agents: number;
  }>(
    `SELECT COUNT(*)::int AS sales_count,
            COALESCE(SUM(s.amount_cents), 0)::int AS total_amount_cents,
            COALESCE(AVG(s.amount_cents), 0)::int AS average_ticket_cents,
            COUNT(DISTINCT s.agent_discord_user_id)::int AS active_agents
     FROM sales s
     JOIN sales_companies c ON c.id = s.company_id
     JOIN sales_products p ON p.id = s.product_id
     WHERE ${where}`,
    params
  );

  const rankingSql = `
    SELECT s.agent_discord_user_id, s.agent_display_name,
           COUNT(*)::int AS sales_count,
           COALESCE(SUM(s.amount_cents), 0)::int AS total_amount_cents
    FROM sales s
    JOIN sales_companies c ON c.id = s.company_id
    JOIN sales_products p ON p.id = s.product_id
    WHERE ${where}
    GROUP BY s.agent_discord_user_id, s.agent_display_name
  `;

  const byClosings = await db.query(`${rankingSql} ORDER BY sales_count DESC, total_amount_cents DESC`, params);
  const byAmount = await db.query(`${rankingSql} ORDER BY total_amount_cents DESC, sales_count DESC`, params);

  const byCompany = await db.query(
    `SELECT c.code, c.name, COUNT(*)::int AS sales_count, COALESCE(SUM(s.amount_cents), 0)::int AS total_amount_cents
     FROM sales s
     JOIN sales_companies c ON c.id = s.company_id
     JOIN sales_products p ON p.id = s.product_id
     WHERE ${where}
     GROUP BY c.code, c.name
     ORDER BY total_amount_cents DESC`,
    params
  );

  const byProduct = await db.query(
    `SELECT c.code AS company_code, p.code, p.name, COUNT(*)::int AS sales_count, COALESCE(SUM(s.amount_cents), 0)::int AS total_amount_cents
     FROM sales s
     JOIN sales_companies c ON c.id = s.company_id
     JOIN sales_products p ON p.id = s.product_id
     WHERE ${where}
     GROUP BY c.code, p.code, p.name
     ORDER BY total_amount_cents DESC`,
    params
  );

  const t = totals.rows[0];
  return {
    range: { from: filters.from, to: filters.to },
    totals: {
      salesCount: t.sales_count,
      totalAmountCents: t.total_amount_cents ?? 0,
      averageTicketCents: t.average_ticket_cents ?? 0,
      activeAgents: t.active_agents,
    },
    rankings: {
      byClosings: byClosings.rows.map((r: any) => ({
        agentDiscordUserId: r.agent_discord_user_id,
        agentDisplayName: r.agent_display_name,
        salesCount: r.sales_count,
        totalAmountCents: r.total_amount_cents,
      })),
      byAmount: byAmount.rows.map((r: any) => ({
        agentDiscordUserId: r.agent_discord_user_id,
        agentDisplayName: r.agent_display_name,
        salesCount: r.sales_count,
        totalAmountCents: r.total_amount_cents,
      })),
    },
    byCompany: byCompany.rows,
    byProduct: byProduct.rows,
  };
}

export async function getSalesList(filters: SalesFilters & { limit: number; offset: number }) {
  const { where, params } = buildWhere(filters);
  const limit = Math.min(Math.max(filters.limit, 1), 500);
  const offset = Math.max(filters.offset, 0);
  const count = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM sales s
     JOIN sales_companies c ON c.id = s.company_id
     JOIN sales_products p ON p.id = s.product_id
     WHERE ${where}`,
    params
  );
  const rows = await db.query<SaleDbRow>(
    `SELECT ${saleSelect}
     FROM sales s
     JOIN sales_companies c ON c.id = s.company_id
     JOIN sales_products p ON p.id = s.product_id
     WHERE ${where}
     ORDER BY s.sold_at DESC, s.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { sales: rows.rows.map(mapSale), total: count.rows[0].count, limit, offset };
}

export async function updateSale(id: number, input: UpdateSaleInput): Promise<SaleRow> {
  const current = await getSaleById(id);
  const companyCode = input.companyCode ?? current.companyCode;
  const productCode = input.productCode ?? current.productCode;
  const { companyId, productId } = await resolveCatalog(companyCode, productCode);
  const signature = input.signatureInput ? parseSignature(input.signatureInput) : {
    status: current.signatureStatus,
    date: current.signatureDate ? current.signatureDate.toISOString().slice(0, 10) : null,
    followupCode: current.followupCode,
  };
  const amountCents = input.amount == null ? current.amountCents : amountToCents(input.amount);
  const clientName = (input.clientName ?? current.clientName).trim();
  if (!clientName) throw new SalesError('invalid_client_name');

  await db.query(
    `UPDATE sales SET
       company_id = $1,
       product_id = $2,
       client_name = $3,
       amount_cents = $4,
       currency = $5,
       billing_period = $6,
       signature_status = $7,
       signature_date = $8,
       followup_code = $9,
       sold_at = $10,
       notes = $11,
       updated_at = NOW()
     WHERE id = $12`,
    [
      companyId,
      productId,
      clientName,
      amountCents,
      (input.currency ?? current.currency).trim().toUpperCase(),
      input.billingPeriod ?? current.billingPeriod,
      signature.status,
      signature.date,
      signature.followupCode,
      input.soldAt?.toISOString() ?? current.soldAt.toISOString(),
      input.notes === undefined ? current.notes : input.notes,
      id,
    ]
  );
  return getSaleById(id);
}

export async function deleteSale(id: number): Promise<void> {
  const result = await db.query('DELETE FROM sales WHERE id = $1', [id]);
  if (result.rowCount === 0) throw new SalesError('sale_not_found');
}
