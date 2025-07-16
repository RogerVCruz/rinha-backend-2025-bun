import * as paymentsRepository from '../repositories/payments.repository';
import { getHealthStatusSync } from './health-check';
import redis from '../infra/redis';
import * as redisQueue from './redis-queue';

async function tryAcquireWorkerLock(): Promise<boolean> {
  try {
    const result = await redis.set('worker_lock', '1', {
      PX: 500, // 500ms TTL
      NX: true
    });
    return result === 'OK';
  } catch (error) {
    console.warn('Worker lock acquisition failed:', error);
    return false;
  }
}

async function markPaymentAsProcessed(correlationId: string): Promise<void> {
  try {
    await redisQueue.markAsProcessed(correlationId);
  } catch (error) {
    console.warn('Failed to mark payment as processed in worker:', error);
  }
}

const attemptPayment = async (
  processor: 'default' | 'fallback',
  body: { correlationId: string; amount: number }
): Promise<boolean> => {
  try {
    const controller = new AbortController();
    // const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`http://payment-processor-${processor}:8080/payments`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Connection': 'close'
      },
      body: JSON.stringify({ ...body, requestedAt: new Date().toISOString() }),
      signal: controller.signal
    });
    
    // clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    return false;
  }
};

async function processPayment(payment: { correlationId: string; amount: number; retryCount: number }): Promise<boolean> {
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
      correlationId: payment.correlationId,
      amount: payment.amount
    })) {
      try {
        // ATOMIC: DB transaction first, then cache
        await paymentsRepository.createTransaction(
          payment.correlationId,
          payment.amount,
          processor
        );
        await redisQueue.markAsProcessed(payment.correlationId);
        return true;
      } catch (error) {
        console.warn(`Worker transaction failed for ${payment.correlationId}:`, error);
        return false; // Will retry
      }
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
    // Get items from main queue and retry queue
    const [mainQueueItems, retryItems] = await Promise.all([
      redisQueue.getFromQueue(20),
      redisQueue.getRetryableItems()
    ]);
    
    const allItems = [...mainQueueItems, ...retryItems];
    
    for (const payment of allItems) {
      const success = await processPayment(payment);
      
      if (success) {
        await redisQueue.markAsProcessed(payment.correlationId);
      } else {
        await redisQueue.addToRetryQueue(payment.correlationId, payment.amount, payment.retryCount);
      }
    }
  } catch (error) {
    console.warn('Payment queue processing failed:', error);
  }
}

export async function processPaymentAsync(
  correlationId: string,
  amount: number
): Promise<void> {
  try {
    const health = getHealthStatusSync();
    const isDefaultAvailable = !health.default.isFailing;
    const isFallbackAvailable = !health.fallback.isFailing;

    const body = { correlationId, amount };

    // Try default processor first (lower fees) - SEQUENTIAL for consistency
    if (isDefaultAvailable) {
      try {
        if (await attemptPayment("default", body)) {
          // ATOMIC: Only mark as processed AFTER successful DB transaction
          await paymentsRepository.createTransaction(
            correlationId,
            amount,
            "default"
          );
          await markPaymentAsProcessed(correlationId);
          return;
        }
      } catch (error) {
        console.warn("Default processor transaction failed:", error);
        // Continue to fallback
      }
    }

    // Try fallback processor if default failed or unavailable
    if (isFallbackAvailable) {
      try {
        if (await attemptPayment("fallback", body)) {
          // ATOMIC: Only mark as processed AFTER successful DB transaction
          await paymentsRepository.createTransaction(
            correlationId,
            amount,
            "fallback"
          );
          await markPaymentAsProcessed(correlationId);
          return;
        }
      } catch (error) {
        console.warn("Fallback processor transaction failed:", error);
        // Continue to queueing
      }
    }

    // All processors failed - try to queue for later (with error handling)
    try {
      await redisQueue.addToQueue(correlationId, amount);
    } catch (error) {
      console.error("Failed to queue payment:", error);
    }
  } catch (error) {
    console.error("Payment processing failed:", error);
  }
}

export function startPaymentWorker() {
  // Immediate processing
  processQueue();
  // Reduced frequency to 200ms for better resource usage
  setInterval(processQueue, 200);
}