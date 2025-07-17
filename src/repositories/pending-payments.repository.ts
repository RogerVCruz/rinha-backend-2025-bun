import sql from '../infra/db';

export interface PendingPayment {
  id: number;
  correlation_id: string;
  amount: number;
  retry_count: number;
}

export async function addPendingPayment(correlationId: string, amount: number) {
  await sql`
    INSERT INTO pending_payments (correlation_id, amount)
    VALUES (${correlationId}, ${amount})
    ON CONFLICT (correlation_id) DO NOTHING;
  `;
}

export async function getPendingPayments(limit = 50): Promise<PendingPayment[]> {
  return sql`
    SELECT id, correlation_id, amount, retry_count
    FROM pending_payments
    WHERE status = 'pending' AND next_retry_at <= NOW() AT TIME ZONE 'UTC'
    ORDER BY next_retry_at
    LIMIT ${limit};
  ` as Promise<PendingPayment[]>;
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

export async function purgePendingPayments() {
  await sql`DELETE FROM pending_payments`;
}