import * as paymentsRepository from '../repositories/payments.repository';
import { getHealthStatusSync } from '../services/health-check';

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
  const health = getHealthStatusSync();
  
  const isDefaultAvailable = !health.default.isFailing;
  const isFallbackAvailable = !health.fallback.isFailing;

  if (isDefaultAvailable) {
    if (await attemptPayment('default', body)) {
      await paymentsRepository.createTransaction(body.correlationId, body.amount, 'default');
      return { message: "Payment processed successfully" };
    }
  }

  if (isFallbackAvailable) {
    if (await attemptPayment('fallback', body)) {
      await paymentsRepository.createTransaction(body.correlationId, body.amount, 'fallback');
      return { message: "Payment processed successfully" };
    }
  }

  await paymentsRepository.addPendingPayment(body.correlationId, body.amount);
  return { message: "Payment queued for processing" };
};