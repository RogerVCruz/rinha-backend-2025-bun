import * as paymentsRepository from '../repositories/payments.repository';

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

export const createPayment = async ({ body }: { body: { correlationId: string; amount: number } }) => {
  const health = await paymentsRepository.getHealthStatus();
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, requestedAt: new Date().toISOString() }),
    });

    if (response.ok) {
      await paymentsRepository.createTransaction(body.correlationId, body.amount, processor);
      return { message: "Payment processed successfully" };
    }

    const nextProcessor = processor === 'default' ? 'fallback' : 'default';
    const nextHealth = nextProcessor === 'default' ? defaultHealth : fallbackHealth;

    if (nextHealth && !nextHealth.is_failing) {
      const fallbackResponse = await fetch(`http://payment-processor-${nextProcessor}:8080/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, requestedAt: new Date().toISOString() }),
      });

      if (fallbackResponse.ok) {
        await paymentsRepository.createTransaction(body.correlationId, body.amount, nextProcessor);
        return { message: "Payment processed successfully" };
      }
    }
    
    return { message: "Payment failed" };

  } catch (error) {
    console.error('Error processing payment:', error);
    return { message: "Payment failed" };
  }
};