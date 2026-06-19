require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const companies = {
  AME: ['IUL', 'EAG', 'WL'],
  NLG: ['IUL', 'EAG', 'WL'],
  ETHOS: ['IUL', 'EAG', 'WL'],
};

const agents = [
  ['mock-agent-001', 'Rodrigo Romero'],
  ['mock-agent-002', 'Ana López'],
  ['mock-agent-003', 'Luis Hernández'],
  ['mock-agent-004', 'María García'],
  ['mock-agent-005', 'Carlos Pérez'],
];

const clients = [
  'Sofía Martínez', 'Miguel Torres', 'Patricia Gómez', 'Jorge Rivera', 'Valeria Ruiz',
  'Andrés Castro', 'Diana Flores', 'Fernando Morales', 'Gabriela Cruz', 'Ricardo Vargas',
  'Elena Navarro', 'Pablo Medina', 'Camila Reyes', 'Héctor Salinas', 'Monserrat Vega',
  'Alberto Luna', 'Natalia Ríos', 'Iván Castillo', 'Lucía Ortega', 'Emilio Santos',
  'Daniela Herrera', 'Raúl Mendoza', 'Andrea Silva', 'Óscar Delgado', 'Paola Aguilar',
  'Brenda Campos', 'Manuel Fuentes', 'Teresa León', 'Francisco Soto', 'Claudia Pineda',
];

const rows = [
  [0, 'AME', 'IUL', 100, 'month', 'IMM'],
  [1, 'AME', 'EAG', 175, 'month', 'UW'],
  [2, 'NLG', 'IUL', 220, 'month', '2026-06-20'],
  [3, 'ETHOS', 'WL', 80, 'month', 'IMM'],
  [4, 'AME', 'WL', 1200, 'once', 'UW'],
  [0, 'NLG', 'EAG', 65, 'month', 'IMM'],
  [1, 'ETHOS', 'IUL', 300, 'month', '2026-06-21'],
  [2, 'AME', 'IUL', 150, 'month', 'IMM'],
  [0, 'AME', 'EAG', 250, 'month', 'IMM'],
  [3, 'NLG', 'WL', 180, 'month', 'UW'],
  [4, 'ETHOS', 'EAG', 95, 'month', 'IMM'],
  [1, 'AME', 'WL', 2000, 'once', '2026-06-24'],
  [2, 'ETHOS', 'IUL', 275, 'month', 'IMM'],
  [3, 'AME', 'EAG', 130, 'month', 'UW'],
  [0, 'NLG', 'IUL', 400, 'month', 'IMM'],
  [4, 'NLG', 'EAG', 75, 'month', '2026-06-25'],
  [1, 'AME', 'IUL', 190, 'month', 'IMM'],
  [2, 'ETHOS', 'WL', 110, 'month', 'UW'],
  [3, 'ETHOS', 'EAG', 350, 'month', 'IMM'],
  [0, 'AME', 'WL', 1600, 'once', '2026-06-28'],
  [1, 'NLG', 'IUL', 210, 'month', 'IMM'],
  [4, 'AME', 'EAG', 140, 'month', 'IMM'],
  [2, 'NLG', 'WL', 70, 'month', 'UW'],
  [3, 'AME', 'IUL', 165, 'month', '2026-06-30'],
  [0, 'ETHOS', 'IUL', 500, 'month', 'IMM'],
  [1, 'ETHOS', 'WL', 125, 'month', 'IMM'],
  [2, 'AME', 'WL', 900, 'once', 'UW'],
  [4, 'NLG', 'EAG', 320, 'month', 'IMM'],
  [0, 'AME', 'IUL', 225, 'month', 'UW'],
  [3, 'ETHOS', 'EAG', 260, 'month', 'IMM'],
];

function sigParts(input) {
  if (input === 'IMM' || input === 'UW') return { status: input, date: null, followup: input };
  return { status: 'DATE', date: input, followup: null };
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const [code, products] of Object.entries(companies)) {
      await client.query(
        `INSERT INTO sales_companies (code, name, active)
         VALUES ($1, $1, TRUE)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = TRUE`,
        [code]
      );
      for (const product of products) {
        await client.query(
          `INSERT INTO sales_products (company_id, code, name, active)
           SELECT id, $2, $2, TRUE FROM sales_companies WHERE code = $1
           ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name, active = TRUE`,
          [code, product]
        );
      }
    }

    await client.query(`DELETE FROM sales WHERE notes = 'mock_dashboard_seed'`);

    for (let i = 0; i < rows.length; i++) {
      const [agentIdx, company, product, amount, period, sig] = rows[i];
      const [agentId, agentName] = agents[agentIdx];
      const sp = sigParts(sig);
      const day = 1 + (i % 16);
      const hour = 10 + (i % 8);
      const soldAt = `2026-06-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:15:00.000Z`;
      await client.query(
        `INSERT INTO sales (
          discord_interaction_id, discord_message_id, discord_guild_id, discord_channel_id,
          agent_discord_user_id, agent_display_name, company_id, product_id, client_name,
          amount_cents, currency, billing_period, signature_status, signature_date, followup_code,
          raw_text, notes, sold_at
        )
        SELECT $1, $2, 'mock-guild', 'mock-sales-channel', $3, $4, c.id, p.id, $5,
               $6, 'USD', $7, $8, $9, $10, $11, 'mock_dashboard_seed', $12::timestamptz
        FROM sales_companies c
        JOIN sales_products p ON p.company_id = c.id
        WHERE c.code = $13 AND p.code = $14`,
        [
          `mock-interaction-${i + 1}`,
          `mock-sale-${i + 1}`,
          agentId,
          agentName,
          clients[i],
          Math.round(amount * 100),
          period,
          sp.status,
          sp.date,
          sp.followup,
          `$${amount}/${period}\n${company}/${product}\n${sig}\n${clients[i]}`,
          soldAt,
          company,
          product,
        ]
      );
    }

    await client.query('COMMIT');
    console.log(`Inserted ${rows.length} mock sales.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
