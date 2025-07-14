import sql from '../db';

export async function getHealthStatus() {
  return sql`SELECT * FROM processor_health`;
}

export async function getSummary(from?: string, to?: string) {
  let filter = sql``;
  if (from && to) {
    filter = sql`WHERE processed_at BETWEEN ${from} AND ${to}`;
  }

  return sql`
      SELECT
        processor,
        COUNT(*) AS total_requests,
        SUM(amount) AS total_amount
      FROM transactions
      ${filter}
      GROUP BY processor;
    `;
}

export async function createTransaction(correlationId: string, amount: number, processor: 'default' | 'fallback') {
  await sql`
      INSERT INTO transactions (correlation_id, amount, processor, processed_at)
      VALUES (${correlationId}, ${amount}, ${processor}, NOW());
    `;
}

export async function updateHealthStatus(processorName: 'default' | 'fallback', isFailing: boolean, minResponseTime: number) {
  await sql`
      INSERT INTO processor_health (processor_name, is_failing, min_response_time, last_checked_at)
      VALUES (${processorName}, ${isFailing}, ${minResponseTime}, NOW())
      ON CONFLICT (processor_name) DO UPDATE
      SET is_failing = EXCLUDED.is_failing,
          min_response_time = EXCLUDED.min_response_time,
          last_checked_at = EXCLUDED.last_checked_at;
    `;
}