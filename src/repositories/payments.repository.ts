import sql from '../infra/db';
import redis from '../infra/redis';

export async function getHealthStatus() {
  return sql`SELECT * FROM processor_health`;
}

async function getCachedSummary(from?: string, to?: string): Promise<any[] | null> {
  try {
    const key = `summary:${from || 'all'}:${to || 'all'}`;
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

async function setCachedSummary(data: any[], from?: string, to?: string): Promise<void> {
  try {
    const key = `summary:${from || 'all'}:${to || 'all'}`;
    await redis.set(key, JSON.stringify(data), { EX: 5 }); // 5s TTL
  } catch {
    // Silent fail
  }
}

export async function getSummary(from?: string, to?: string) {
  // Try cache first
  const cached = await getCachedSummary(from, to);
  if (cached) {
    return cached;
  }

  let filter = sql``;
  if (from && to) {
    filter = sql`WHERE processed_at BETWEEN ${from} AND ${to}`;
  }

  const result = await sql`
      SELECT
        processor,
        COUNT(*) AS total_requests,
        SUM(amount) AS total_amount
      FROM transactions
      ${filter}
      GROUP BY processor;
    `;

  // Cache the result
  await setCachedSummary(result, from, to);
  return result;
}

async function invalidateSummaryCache(): Promise<void> {
  try {
    // Invalidate common summary cache keys
    await Promise.all([
      redis.del('summary:all:all'),
      redis.del('summary:undefined:undefined')
    ]);
  } catch {
    // Silent fail
  }
}

export async function createTransaction(correlationId: string, amount: number, processor: 'default' | 'fallback') {
  await sql`
      INSERT INTO transactions (correlation_id, amount, processor, processed_at)
      VALUES (${correlationId}, ${amount}, ${processor}, NOW());
    `;
  
  // Invalidate summary cache when new transaction is added
  await invalidateSummaryCache();
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

export async function addPendingPayment(correlationId: string, amount: number) {
  await sql`
      INSERT INTO pending_payments (correlation_id, amount)
      VALUES (${correlationId}, ${amount});
    `;
}

export async function getPendingPayments(limit = 50) {
  return sql`
      SELECT id, correlation_id, amount, retry_count
      FROM pending_payments
      WHERE status = 'pending' AND next_retry_at <= NOW()
      ORDER BY next_retry_at
      LIMIT ${limit};
    `;
}

export async function markPaymentProcessed(id: number) {
  await sql`
      UPDATE pending_payments
      SET status = 'processed'
      WHERE id = ${id};
    `;
}

export async function markPaymentFailed(id: number, retryCount: number) {
  const nextRetryDelay = Math.min(300, Math.pow(2, retryCount) * 5);
  
  if (retryCount >= 10) {
    await sql`
        UPDATE pending_payments
        SET status = 'failed'
        WHERE id = ${id};
      `;
  } else {
    await sql`
        UPDATE pending_payments
        SET retry_count = ${retryCount + 1},
            next_retry_at = NOW() + INTERVAL '${nextRetryDelay} seconds'
        WHERE id = ${id};
      `;
  }
}