import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireDashboardJwt, requireInternalSecret } from '../middleware/auth';
import {
  createSale,
  deleteSale,
  getSalesCatalog,
  getSalesList,
  getSalesSummary,
  SalesError,
  updateSale,
  type SaleRow,
} from '../services/sales';
import { logger } from '../utils/logger';

const billingPeriodSchema = z.enum(['once', 'month', 'year']);

const createSaleSchema = z.object({
  discordInteractionId: z.string().min(1).nullable().optional(),
  discordMessageId: z.string().min(1).nullable().optional(),
  discordGuildId: z.string().min(1).nullable().optional(),
  discordChannelId: z.string().min(1).nullable().optional(),
  agentDiscordUserId: z.string().min(1),
  agentDisplayName: z.string().min(1),
  companyCode: z.string().min(1),
  productCode: z.string().min(1),
  clientName: z.string().min(1),
  amount: z.coerce.number().positive(),
  currency: z.string().min(1).default('USD'),
  billingPeriod: billingPeriodSchema.default('month'),
  signatureInput: z.string().min(1),
  rawText: z.string().nullable().optional(),
  soldAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().nullable().optional(),
});

const salesFilterSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  company: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  agentDiscordUserId: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});

const salesListSchema = salesFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const updateSaleSchema = z.object({
  companyCode: z.string().min(1).optional(),
  productCode: z.string().min(1).optional(),
  clientName: z.string().min(1).optional(),
  amount: z.coerce.number().positive().optional(),
  currency: z.string().min(1).optional(),
  billingPeriod: billingPeriodSchema.optional(),
  signatureInput: z.string().min(1).optional(),
  soldAt: z.string().datetime({ offset: true }).optional(),
  notes: z.string().nullable().optional(),
});

function serializeSale(sale: SaleRow) {
  return {
    id: sale.id,
    discordInteractionId: sale.discordInteractionId,
    discordMessageId: sale.discordMessageId,
    discordGuildId: sale.discordGuildId,
    discordChannelId: sale.discordChannelId,
    agentDiscordUserId: sale.agentDiscordUserId,
    agentDisplayName: sale.agentDisplayName,
    companyCode: sale.companyCode,
    companyName: sale.companyName,
    productCode: sale.productCode,
    productName: sale.productName,
    clientName: sale.clientName,
    amountCents: sale.amountCents,
    currency: sale.currency,
    billingPeriod: sale.billingPeriod,
    signatureStatus: sale.signatureStatus,
    signatureDate: sale.signatureDate?.toISOString().slice(0, 10) ?? null,
    followupCode: sale.followupCode,
    rawText: sale.rawText,
    notes: sale.notes,
    soldAt: sale.soldAt.toISOString(),
    createdAt: sale.createdAt.toISOString(),
    updatedAt: sale.updatedAt.toISOString(),
  };
}

function salesErrorReply(err: unknown, reply: any) {
  if (err instanceof SalesError) {
    const status = err.code === 'sale_not_found' ? 404 : err.code === 'duplicate_sale' ? 409 : 400;
    return reply.code(status).send({ error: err.code });
  }
  throw err;
}

function parseRange(data: z.infer<typeof salesFilterSchema>) {
  const from = new Date(data.from);
  const to = new Date(data.to);
  if (from >= to) throw new SalesError('invalid_range');
  return {
    from,
    to,
    company: data.company,
    product: data.product,
    agentDiscordUserId: data.agentDiscordUserId ?? data.agent,
  };
}

export async function salesRoutes(app: FastifyInstance) {
  app.get('/sales/catalog', { preHandler: requireInternalSecret }, async (_req, reply) => {
    const catalog = await getSalesCatalog();
    return reply.code(200).send(catalog);
  });

  app.get('/dashboard/sales/catalog', { preHandler: requireDashboardJwt }, async (_req, reply) => {
    const catalog = await getSalesCatalog();
    return reply.code(200).send(catalog);
  });

  app.post('/sales', { preHandler: requireInternalSecret }, async (req, reply) => {
    const parsed = createSaleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', detail: parsed.error.flatten() });
    }

    try {
      const sale = await createSale({
        ...parsed.data,
        soldAt: parsed.data.soldAt ? new Date(parsed.data.soldAt) : null,
      });
      logger.info({ saleId: sale.id, agentDiscordUserId: sale.agentDiscordUserId }, 'sale recorded');
      return reply.code(200).send({ sale: serializeSale(sale) });
    } catch (err) {
      try {
        return salesErrorReply(err, reply);
      } catch (unexpected) {
        logger.error({ err: unexpected }, 'Unexpected error creating sale');
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  });

  app.get<{ Querystring: Record<string, string> }>(
    '/dashboard/sales/summary',
    { preHandler: requireDashboardJwt },
    async (req, reply) => {
      const parsed = salesFilterSchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid query params', detail: parsed.error.flatten() });

      try {
        const filters = parseRange(parsed.data);
        const summary = await getSalesSummary(filters);
        return reply.code(200).send({
          ...summary,
          range: { from: summary.range.from.toISOString(), to: summary.range.to.toISOString() },
        });
      } catch (err) {
        try {
          return salesErrorReply(err, reply);
        } catch (unexpected) {
          logger.error({ err: unexpected }, 'Unexpected error fetching sales summary');
          return reply.code(500).send({ error: 'Internal server error' });
        }
      }
    }
  );

  app.get<{ Querystring: Record<string, string> }>(
    '/dashboard/sales',
    { preHandler: requireDashboardJwt },
    async (req, reply) => {
      const parsed = salesListSchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid query params', detail: parsed.error.flatten() });

      try {
        const filters = parseRange(parsed.data);
        const page = await getSalesList({ ...filters, limit: parsed.data.limit, offset: parsed.data.offset });
        return reply.code(200).send({ ...page, sales: page.sales.map(serializeSale) });
      } catch (err) {
        try {
          return salesErrorReply(err, reply);
        } catch (unexpected) {
          logger.error({ err: unexpected }, 'Unexpected error fetching sales list');
          return reply.code(500).send({ error: 'Internal server error' });
        }
      }
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/dashboard/sales/:id',
    { preHandler: requireDashboardJwt },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_sale_id' });
      const parsed = updateSaleSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body', detail: parsed.error.flatten() });

      try {
        const sale = await updateSale(id, {
          ...parsed.data,
          soldAt: parsed.data.soldAt ? new Date(parsed.data.soldAt) : undefined,
        });
        return reply.code(200).send({ sale: serializeSale(sale) });
      } catch (err) {
        try {
          return salesErrorReply(err, reply);
        } catch (unexpected) {
          logger.error({ err: unexpected, saleId: id }, 'Unexpected error updating sale');
          return reply.code(500).send({ error: 'Internal server error' });
        }
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/dashboard/sales/:id',
    { preHandler: requireDashboardJwt },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_sale_id' });
      try {
        await deleteSale(id);
        return reply.code(200).send({ ok: true });
      } catch (err) {
        try {
          return salesErrorReply(err, reply);
        } catch (unexpected) {
          logger.error({ err: unexpected, saleId: id }, 'Unexpected error deleting sale');
          return reply.code(500).send({ error: 'Internal server error' });
        }
      }
    }
  );
}
