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
  } catch (error) {
    console.warn('Cache read failed for summary:', error);
    return null;
  }
}

async function setCachedSummary(data: any[], from?: string, to?: string): Promise<void> {
  try {
    const key = `summary:${from || 'all'}:${to || 'all'}`;
    // Intelligent TTL: shorter for recent data, longer for historical data
    const isRecentQuery = from && to && new Date(to).getTime() > Date.now() - 60000; // within last minute
    const ttl = isRecentQuery ? 2 : 30; // 2s for recent, 30s for historical
    
    await redis.set(key, JSON.stringify(data), { EX: ttl });
  } catch (error) {
    console.warn('Cache write failed for summary:', error);
  }
}

export async function getSummary(from?: string, to?: string) {
  const startTime = Date.now();
  
  // Try cache first
  const cached = await getCachedSummary(from, to);
  if (cached) {
    console.log(`Summary cache hit in ${Date.now() - startTime}ms for range: ${from || 'all'} to ${to || 'all'}`);
    return cached;
  }

  // Build optimized filter for UTC timestamps
  let filter = sql``;
  if (from && to) {
    // Ensure timestamps are treated as UTC and convert to proper format
    const fromUTC = new Date(from).toISOString();
    const toUTC = new Date(to).toISOString();
    filter = sql`WHERE processed_at BETWEEN ${fromUTC}::timestamptz AND ${toUTC}::timestamptz`;
  }

  const queryStartTime = Date.now();
  
  // Optimized query with proper type casting for consistency
  const result = await sql`
      SELECT
        processor,
        COUNT(*)::integer AS total_requests,
        COALESCE(SUM(amount), 0)::numeric(10,2) AS total_amount
      FROM transactions
      ${filter}
      GROUP BY processor
      ORDER BY processor;
    `;

  const queryTime = Date.now() - queryStartTime;
  console.log(`Summary query executed in ${queryTime}ms for range: ${from || 'all'} to ${to || 'all'}, rows: ${result.length}`);

  // Always return both processors even if no data exists
  const processedResult = ensureAllProcessors(result);
  
  // Cache the result
  await setCachedSummary(processedResult, from, to);
  
  const totalTime = Date.now() - startTime;
  console.log(`Summary total time: ${totalTime}ms (query: ${queryTime}ms)`);
  
  return processedResult;
}

// Helper function to ensure both default and fallback processors are always present
function ensureAllProcessors(queryResult: any[]): any[] {
  const processors = ['default', 'fallback'];
  const resultMap = new Map();
  
  // Map existing results
  queryResult.forEach(row => {
    resultMap.set(row.processor, row);
  });
  
  // Ensure all processors exist with zero values if missing
  return processors.map(processor => {
    if (resultMap.has(processor)) {
      return resultMap.get(processor);
    } else {
      return {
        processor,
        total_requests: 0,
        total_amount: 0
      };
    }
  });
}

async function invalidateSummaryCache(): Promise<void> {
  try {
    // Invalidate common summary cache keys
    await Promise.all([
      redis.del('summary:all:all'),
      redis.del('summary:undefined:undefined')
    ]);
  } catch (error) {
    console.warn('Cache invalidation failed:', error);
  }
}

export async function createTransaction(correlationId: string, amount: number, processor: 'default' | 'fallback') {
  return await sql.begin(async sql => {
    // Insert transaction within transaction block
    await sql`
        INSERT INTO transactions (correlation_id, amount, processor, processed_at)
        VALUES (${correlationId}, ${amount}, ${processor}, NOW() AT TIME ZONE 'UTC')
        ON CONFLICT (correlation_id) DO NOTHING;
      `;
    
    // Invalidate summary cache when new transaction is added
    await invalidateSummaryCache();
    
    return { correlation_id: correlationId };
  });
}

export async function checkPaymentExists(correlationId: string) {
  return sql`
      SELECT correlation_id FROM transactions 
      WHERE correlation_id = ${correlationId}
      LIMIT 1;
    `;
}

export async function updateHealthStatus(processorName: 'default' | 'fallback', isFailing: boolean, minResponseTime: number) {
  await sql`
      INSERT INTO processor_health (processor_name, is_failing, min_response_time, last_checked_at)
      VALUES (${processorName}, ${isFailing}, ${minResponseTime}, NOW() AT TIME ZONE 'UTC')
      ON CONFLICT (processor_name) DO UPDATE
      SET is_failing = EXCLUDED.is_failing,
          min_response_time = EXCLUDED.min_response_time,
          last_checked_at = EXCLUDED.last_checked_at;
    `;
}

export async function addPendingPayment(correlationId: string, amount: number) {
  await sql`
      INSERT INTO pending_payments (correlation_id, amount)
      VALUES (${correlationId}, ${amount})
      ON CONFLICT (correlation_id) DO NOTHING;
    `;
}

export async function getPendingPayments(limit = 50) {
  return sql`
      SELECT id, correlation_id, amount, retry_count
      FROM pending_payments
      WHERE status = 'pending' AND next_retry_at <= NOW() AT TIME ZONE 'UTC'
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
            next_retry_at = ${new Date(Date.now() + nextRetryDelay * 1000)}
        WHERE id = ${id};
      `;
  }
}

export async function purgeAllPayments() {
  try {
    await Promise.all([
      sql`DELETE FROM transactions`,
      sql`DELETE FROM pending_payments`,
      redis.flushAll() // Clear all Redis cache
    ]);
  } catch (error) {
    console.warn('Full purge failed, trying database only:', error);
    try {
      await Promise.all([
        sql`DELETE FROM transactions`,
        sql`DELETE FROM pending_payments`
      ]);
    } catch (dbError) {
      console.error('Database purge failed:', dbError);
      throw dbError; // Re-throw to indicate failure
    }
  }
}