import * as paymentsRepository from '../repositories/payments.repository';
import { getHealthStatusSync } from './health-check';
import redis from '../infra/redis';

async function tryAcquireWorkerLock(): Promise<boolean> {
  try {
    const result = await redis.set('worker_lock', '1', {
      PX: 500, // 500ms TTL
      NX: true
    });
    return result === 'OK';
  } catch {
    return false;
  }
}

async function markPaymentAsProcessed(correlationId: string): Promise<void> {
  try {
    await redis.set(`payment:${correlationId}`, '1', { EX: 3600 });
  } catch {
    // Silent fail
  }
}

const attemptPayment = async (
  processor: 'default' | 'fallback',
  body: { correlationId: string; amount: number }
): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);

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

async function processPayment(payment: any): Promise<boolean> {
  const health = getHealthStatusSync();
  
  const processors: Array<'default' | 'fallback'> = [];
  
  if (!health.default.isFailing) {
    processors.push('default');
  }
  if (!health.fallback.isFailing) {
    processors.push('fallback');
  }
  
  for (const processor of processors) {
    if (await attemptPayment(processor, {
      correlationId: payment.correlation_id,
      amount: payment.amount
    })) {
      await markPaymentAsProcessed(payment.correlation_id);
      await paymentsRepository.createTransaction(
        payment.correlation_id,
        payment.amount,
        processor
      );
      return true;
    }
  }
  
  return false;
}

async function processQueue() {
  // Try to acquire lock for queue processing
  const hasLock = await tryAcquireWorkerLock();
  if (!hasLock) {
    return; // Another instance is processing the queue
  }

  try {
    const pendingPayments = await paymentsRepository.getPendingPayments(20);
    
    for (const payment of pendingPayments) {
      const success = await processPayment(payment);
      
      if (success) {
        await paymentsRepository.markPaymentProcessed(payment.id);
      } else {
        await paymentsRepository.markPaymentFailed(payment.id, payment.retry_count);
      }
    }
  } catch (error) {
    // Silent fail to avoid spam
  }
}

export function startPaymentWorker() {
  setInterval(processQueue, 100);
  processQueue();
}