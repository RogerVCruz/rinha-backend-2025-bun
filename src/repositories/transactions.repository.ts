import sql from '../infra/db';
import { CacheService } from '../services/cache.service';

export type ProcessorType = 'default' | 'fallback';

export interface TransactionSummary {
  processor: ProcessorType;
  total_requests: number;
  total_amount: number;
}

function ensureAllProcessors(queryResult: TransactionSummary[]): TransactionSummary[] {
  const processors: ProcessorType[] = ['default', 'fallback'];
  const resultMap = new Map<ProcessorType, TransactionSummary>();
  
  queryResult.forEach(row => {
    resultMap.set(row.processor, row);
  });
  
  return processors.map(processor => {
    return resultMap.get(processor) || {
      processor,
      total_requests: 0,
      total_amount: 0
    };
  });
}

export async function createTransaction(correlationId: string, amount: number, processor: ProcessorType) {
  return await sql.begin(async sql => {
    await sql`
      INSERT INTO transactions (correlation_id, amount, processor, processed_at)
      VALUES (${correlationId}, ${amount}, ${processor}, NOW() AT TIME ZONE 'UTC')
      ON CONFLICT (correlation_id) DO NOTHING;
    `;
    
    await CacheService.invalidateSummary();
    
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

export async function getSummary(from?: string, to?: string): Promise<TransactionSummary[]> {
  const cached = await CacheService.getSummary(from, to);
  if (cached) {
    return cached;
  }

  const whereClause = from && to 
    ? sql`WHERE processed_at >= ${from} AND processed_at <= ${to}`
    : sql``;

  const result = await sql`
    SELECT 
      processor,
      COUNT(*)::int as total_requests,
      COALESCE(SUM(amount), 0)::numeric as total_amount
    FROM transactions 
    ${whereClause}
    GROUP BY processor
  `;

  const processedResult = ensureAllProcessors(result as TransactionSummary[]);
  await CacheService.setSummary(processedResult, from, to);

  return processedResult;
}

export async function purgeTransactions() {
  await sql`DELETE FROM transactions`;
}