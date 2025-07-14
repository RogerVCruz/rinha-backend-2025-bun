import * as paymentsRepository from '../repositories/payments.repository';
import { getHealthStatusSync } from '../services/health-check';
import redis from '../infra/redis';

async function isPaymentAlreadyProcessed(correlationId: string): Promise<boolean> {
  try {
    const exists = await redis.exists(`payment:${correlationId}`);
    return exists === 1;
  } catch {
    return false;
  }
}

async function markPaymentAsProcessed(correlationId: string): Promise<void> {
  try {
    await redis.set(`payment:${correlationId}`, '1', { EX: 3600 }); // 1 hour TTL
  } catch {
    // Silent fail
  }
}

export const getPaymentsSummary = async ({ query }: { query: { from?: string; to?: string } }) => {
  const result = await paymentsRepository.getSummary(query.from, query.to);

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

const attemptPayment = async (
  processor: 'default' | 'fallback',
  body: { correlationId: string; amount: number }
): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 500);

    const response = await fetch(`http://payment-processor-${processor}:8080/payments`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Connection': 'close'
      },
      body: JSON.stringify({ ...body, requestedAt: new Date().toISOString() }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    return false;
  }
};

export const createPayment = async ({ body }: { body: { correlationId: string; amount: number } }) => {
  // Check for duplicate payment first
  if (await isPaymentAlreadyProcessed(body.correlationId)) {
    return { message: "Payment already processed" };
  }

  const health = getHealthStatusSync();
  
  const isDefaultAvailable = !health.default.isFailing;
  const isFallbackAvailable = !health.fallback.isFailing;

  if (isDefaultAvailable) {
    if (await attemptPayment('default', body)) {
      await markPaymentAsProcessed(body.correlationId);
      await paymentsRepository.createTransaction(body.correlationId, body.amount, 'default');
      return { message: "Payment processed successfully" };
    }
  }

  if (isFallbackAvailable) {
    if (await attemptPayment('fallback', body)) {
      await markPaymentAsProcessed(body.correlationId);
      await paymentsRepository.createTransaction(body.correlationId, body.amount, 'fallback');
      return { message: "Payment processed successfully" };
    }
  }

  await paymentsRepository.addPendingPayment(body.correlationId, body.amount);
  return { message: "Payment queued for processing" };
};