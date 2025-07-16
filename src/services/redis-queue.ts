import redis from '../infra/redis';

interface QueueItem {
  correlationId: string;
  amount: number;
  retryCount: number;
  nextRetryAt: number;
}

const QUEUE_KEY = 'payment_queue';
const RETRY_QUEUE_KEY = 'payment_retry_queue';
const PROCESSING_KEY = 'payment_processing';

export async function addToQueue(correlationId: string, amount: number): Promise<void> {
  const item: QueueItem = {
    correlationId,
    amount,
    retryCount: 0,
    nextRetryAt: Date.now()
  };
  
  try {
    const added = await redis.set(`queue_item:${correlationId}`, '1', { NX: true, EX: 3600 });
    if (added === 'OK') {
      await redis.lPush(QUEUE_KEY, JSON.stringify(item));
    }
  } catch (error) {
    console.error('Failed to add to queue:', error);
    throw error;
  }
}

export async function getFromQueue(limit = 20): Promise<QueueItem[]> {
  try {
    const pipeline = redis.multi();
    
    for (let i = 0; i < limit; i++) {
      pipeline.rPop(QUEUE_KEY);
    }
    
    const results = await pipeline.exec();
    const items: QueueItem[] = [];
    
    if (results && Array.isArray(results)) {
      for (const result of results) {
        if (result && Array.isArray(result) && result[1]) {
          try {
            items.push(JSON.parse(result[1] as string));
          } catch (parseError) {
            console.warn('Failed to parse queue item:', parseError);
          }
        }
      }
    }
    
    return items;
  } catch (error) {
    console.error('Failed to get from queue:', error);
    return [];
  }
}

export async function getRetryableItems(): Promise<QueueItem[]> {
  try {
    const now = Date.now();
    const items = await redis.zRangeByScore(RETRY_QUEUE_KEY, 0, now);
    
    if (items.length > 0) {
      await redis.zRemRangeByScore(RETRY_QUEUE_KEY, 0, now);
      
      return items.map(item => {
        try {
          return JSON.parse(item);
        } catch (error) {
          console.warn('Failed to parse retry item:', error);
          return null;
        }
      }).filter(Boolean) as QueueItem[];
    }
    
    return [];
  } catch (error) {
    console.error('Failed to get retryable items:', error);
    return [];
  }
}

export async function markAsProcessed(correlationId: string): Promise<void> {
  try {
    await Promise.all([
      redis.del(`queue_item:${correlationId}`),
      redis.set(`payment:${correlationId}`, '1', { EX: 3600 })
    ]);
  } catch (error) {
    console.error('Failed to mark as processed:', error);
  }
}

export async function addToRetryQueue(correlationId: string, amount: number, retryCount: number): Promise<void> {
  try {
    const maxRetries = 10;
    
    if (retryCount >= maxRetries) {
      await redis.del(`queue_item:${correlationId}`);
      await redis.set(`payment_failed:${correlationId}`, '1', { EX: 86400 }); // 24h
      return;
    }
    
    const delay = Math.min(300, Math.pow(2, retryCount) * 5) * 1000;
    const nextRetryAt = Date.now() + delay;
    
    const item: QueueItem = {
      correlationId,
      amount,
      retryCount: retryCount + 1,
      nextRetryAt
    };
    
    await redis.zAdd(RETRY_QUEUE_KEY, { score: nextRetryAt, value: JSON.stringify(item) });
  } catch (error) {
    console.error('Failed to add to retry queue:', error);
  }
}

export async function getAllItems(): Promise<QueueItem[]> {
  try {
    const [mainQueue, retryQueue] = await Promise.all([
      getFromQueue(1000),
      getRetryableItems()
    ]);
    
    return [...mainQueue, ...retryQueue];
  } catch (error) {
    console.error('Failed to get all items:', error);
    return [];
  }
}

export async function purgeAllQueues(): Promise<void> {
  try {
    const pipeline = redis.multi();
    
    const keys = await redis.keys('queue_item:*');
    const paymentKeys = await redis.keys('payment:*');
    const failedKeys = await redis.keys('payment_failed:*');

    pipeline.del(QUEUE_KEY);
    pipeline.del(RETRY_QUEUE_KEY);
    pipeline.del(PROCESSING_KEY);
    
    if (keys.length > 0) pipeline.del(keys);
    if (paymentKeys.length > 0) pipeline.del(paymentKeys);
    if (failedKeys.length > 0) pipeline.del(failedKeys);
    
    await pipeline.exec();
  } catch (error) {
    console.error('Failed to purge queues:', error);
    throw error;
  }
}