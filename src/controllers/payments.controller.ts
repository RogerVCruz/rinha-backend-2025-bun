import { Elysia, t } from 'elysia';
import sql from '../db';

export const getPaymentsSummary = async ({ query }: { query: { from?: string; to?: string } }) => {
  const { from, to } = query;

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

  const summary = {
    default: {
      totalRequests: 0,
      totalAmount: 0,
    },
    fallback: {
      totalRequests: 0,
      totalAmount: 0,
    },
  };

  for (const row of result) {
    const processor = row.processor;
    if (processor === 'default' || processor === 'fallback') {
      summary[processor as 'default' | 'fallback'] = {
        totalRequests: Number(row.total_requests),
        totalAmount: Number(row.total_amount),
      };
    }
  }

  return summary;
};

export const createPayment = async ({ body }: { body: { correlationId: string; amount: number } }) => {
  const health = await sql`SELECT * FROM processor_health`;
  const defaultHealth = health.find(h => h.processor_name === 'default');
  const fallbackHealth = health.find(h => h.processor_name === 'fallback');

  let processor: 'default' | 'fallback' | null = null;

  if (defaultHealth && !defaultHealth.is_failing) {
    processor = 'default';
  } else if (fallbackHealth && !fallbackHealth.is_failing) {
    processor = 'fallback';
  }

  if (!processor) {
    return { message: "Both payment processors are unavailable" };
  }

  try {
    const response = await fetch(`http://payment-processor-${processor}:8080/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...body,
        requestedAt: new Date().toISOString(),
      }),
    });

    if (response.ok) {
      await sql`
          INSERT INTO transactions (correlation_id, amount, processor, processed_at)
          VALUES (${body.correlationId}, ${body.amount}, ${processor}, NOW());
        `;
      return { message: "Payment processed successfully" };
    } else {
      // Se o processador escolhido falhar, tenta o outro se estiver disponível
      let nextProcessor: 'default' | 'fallback' | null = null;
      if (processor === 'default' && fallbackHealth && !fallbackHealth.is_failing) {
        nextProcessor = 'fallback';
      } else if (processor === 'fallback' && defaultHealth && !defaultHealth.is_failing) {
        nextProcessor = 'default';
      } else {
        return { message: "Payment failed" };
      }

      const fallbackResponse = await fetch(`http://payment-processor-${nextProcessor}:8080/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...body,
          requestedAt: new Date().toISOString(),
        }),
      });

      if (fallbackResponse.ok) {
        await sql`
            INSERT INTO transactions (correlation_id, amount, processor, processed_at)
            VALUES (${body.correlationId}, ${body.amount}, ${nextProcessor}, NOW());
          `;
        return { message: "Payment processed successfully" };
      } else {
        return { message: "Payment failed" };
      }
    }
  } catch (error) {
    console.error('Error processing payment:', error);
    return { message: "Payment failed" };
  }
};