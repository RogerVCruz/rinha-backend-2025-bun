import redis from '../infra/redis';

// Interface para o item da fila
export interface QueueItem {
  correlationId: string;
  amount: number;
  retryCount: number;
  nextRetryAt: number;
}

// Interface para o retorno das funções que pegam itens, incluindo o item bruto
export interface DequeuedItem {
  raw: string;
  parsed: QueueItem;
}

// Chaves do Redis
const QUEUE_KEY = 'payment_queue';
const RETRY_QUEUE_KEY = 'payment_retry_queue';
const PROCESSING_KEY = 'payment_processing'; // Fila para itens em processamento

/**
 * Script Lua para atomicamente pegar e remover itens da fila de retry (Sorted Set).
 */
const GET_AND_REMOVE_RETRY_ITEMS_SCRIPT = `
  local items = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
  if #items > 0 then
    redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
  end
  return items
`;

/**
 * Adiciona um novo pagamento à fila principal.
 */
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
      console.log(`[QUEUE-LOG] ADDED TO MAIN QUEUE: ${correlationId}`); // LOG
      await redis.lPush(QUEUE_KEY, JSON.stringify(item));
    } else {
      console.log(`[QUEUE-LOG] DUPLICATE IGNORED: ${correlationId}`); // LOG
    }
  } catch (error) {
    console.error('Failed to add to queue:', error);
    throw error;
  }
}

/**
 * Pega itens da fila principal de forma segura.
 */
export async function getFromQueue(limit = 20): Promise<DequeuedItem[]> {
  try {
    console.log(`[QUEUE-LOG] WORKER: Checking main queue (limit: ${limit})...`); // LOG
    const items: DequeuedItem[] = [];
    for (let i = 0; i < limit; i++) {
      const rawItem = await redis.lMove(QUEUE_KEY, PROCESSING_KEY, 'RIGHT', 'LEFT');
      if (rawItem) {
        items.push({ raw: rawItem, parsed: JSON.parse(rawItem) });
      } else {
        break;
      }
    }
    if (items.length > 0) {
        console.log(`[QUEUE-LOG] WORKER: Moved ${items.length} items from main queue to processing.`); // LOG
    }
    return items;
  } catch (error) {
    console.error('Failed to get from queue:', error);
    return [];
  }
}

/**
 * Pega itens da fila de retry de forma atômica.
 */
export async function getRetryableItems(): Promise<DequeuedItem[]> {
  try {
    console.log(`[QUEUE-LOG] WORKER: Checking retry queue...`); // LOG
    const now = Date.now();
    const rawItems = await redis.eval(GET_AND_REMOVE_RETRY_ITEMS_SCRIPT, {
      keys: [RETRY_QUEUE_KEY],
      arguments: [String(now)],
    }) as string[];

    if (rawItems && rawItems.length > 0) {
      console.log(`[QUEUE-LOG] WORKER: Moved ${rawItems.length} items from retry queue to processing.`); // LOG
      await redis.lPush(PROCESSING_KEY, rawItems);
      return rawItems.map(raw => ({ raw, parsed: JSON.parse(raw) }));
    }
    
    return [];
  } catch (error) {
    console.error('Failed to get retryable items:', error);
    return [];
  }
}

/**
 * Marca um pagamento como totalmente processado.
 */
export async function markAsProcessed(correlationId: string, rawItem?: string): Promise<void> {
  try {
    console.log(`[QUEUE-LOG] MARKING PROCESSED: ${correlationId}`); // LOG
    const pipeline = redis.multi();

    if (typeof rawItem === 'string' && rawItem.length > 0) {
      console.log(`[QUEUE-LOG]   -> Removing from processing list: ${correlationId}`); // LOG
      pipeline.lRem(PROCESSING_KEY, 1, rawItem);
    } else {
      console.log(`[QUEUE-LOG]   -> No rawItem provided, not removing from processing list (API flow).`); // LOG
    }
    
    pipeline.del(`queue_item:${correlationId}`);
    pipeline.set(`payment_processed:${correlationId}`, '1', { EX: 3600 });
    
    await pipeline.exec();
    console.log(`[QUEUE-LOG]   -> Successfully marked processed: ${correlationId}`); // LOG
  } catch (error) {
    console.error(`Failed to mark as processed for ${correlationId}:`, error);
  }
}

/**
 * Adiciona um item à fila de retentativas.
 */
export async function addToRetryQueue(rawItem: string): Promise<void> {
  try {
    const item: QueueItem = JSON.parse(rawItem);
    console.log(`[QUEUE-LOG] ADDING TO RETRY: ${item.correlationId} (Retry count: ${item.retryCount + 1})`); // LOG
    const maxRetries = 10;
    
    await redis.lRem(PROCESSING_KEY, 1, rawItem);

    if (item.retryCount >= maxRetries) {
      console.warn(`[QUEUE-LOG]   -> Max retries reached for ${item.correlationId}. Marking as failed.`); // LOG
      await redis.del(`queue_item:${item.correlationId}`);
      await redis.set(`payment_failed:${item.correlationId}`, '1', { EX: 86400 });
      return;
    }
    
    const delay = Math.min(300, Math.pow(2, item.retryCount) * 5) * 1000;
    const nextRetryAt = Date.now() + delay;
    
    const newItem: QueueItem = {
      ...item,
      retryCount: item.retryCount + 1,
      nextRetryAt
    };
    
    await redis.zAdd(RETRY_QUEUE_KEY, { score: nextRetryAt, value: JSON.stringify(newItem) });
  } catch (error) {
    console.error('Failed to add to retry queue:', error);
  }
}

/**
 * Adiciona múltiplos itens à fila de retentativas.
 */
export async function addManyToRetryQueue(rawItems: string[]): Promise<void> {
  if (rawItems.length === 0) return;

  try {
    const pipeline = redis.multi();
    const itemsToRetry = [];

    for (const rawItem of rawItems) {
      const item: QueueItem = JSON.parse(rawItem);
      const maxRetries = 10;

      pipeline.lRem(PROCESSING_KEY, 1, rawItem);

      if (item.retryCount >= maxRetries) {
        pipeline.del(`queue_item:${item.correlationId}`);
        pipeline.set(`payment_failed:${item.correlationId}`, '1', { EX: 86400 });
      } else {
        const delay = Math.min(300, Math.pow(2, item.retryCount) * 5) * 1000;
        const nextRetryAt = Date.now() + delay;
        const newItem: QueueItem = { ...item, retryCount: item.retryCount + 1, nextRetryAt };
        itemsToRetry.push({ score: nextRetryAt, value: JSON.stringify(newItem) });
      }
    }

    if (itemsToRetry.length > 0) {
      pipeline.zAdd(RETRY_QUEUE_KEY, itemsToRetry);
    }

    await pipeline.exec();
  } catch (error) {
    console.error('Failed to add to retry queue in batch:', error);
  }
}


/**
 * Marca múltiplos pagamentos como totalmente processados.
 */
export async function markManyAsProcessed(items: { correlationId: string, raw: string }[]): Promise<void> {
  if (items.length === 0) return;

  try {
    const pipeline = redis.multi();
    const processedKeys = [];
    const queueItemKeys = [];

    for (const item of items) {
      pipeline.lRem(PROCESSING_KEY, 1, item.raw);
      queueItemKeys.push(`queue_item:${item.correlationId}`);
      processedKeys.push(`payment_processed:${item.correlationId}`);
    }

    pipeline.del(queueItemKeys);
    
    // Define chaves de pagamento processado com expiração
    const multiSet = redis.multi();
    for (const key of processedKeys) {
        multiSet.set(key, '1', { EX: 3600 });
    }
    await multiSet.exec();

    await pipeline.exec();
  } catch (error) {
    console.error('Failed to mark as processed in batch:', error);
  }
}

/**
 * Limpa todas as filas e chaves relacionadas.
 */
export async function purgeAllQueues(): Promise<void> {
  try {
    const keys = await redis.keys('queue_item:*');
    const paymentKeys = await redis.keys('payment_*:*');

    const pipeline = redis.multi()
      .del(QUEUE_KEY)
      .del(RETRY_QUEUE_KEY)
      .del(PROCESSING_KEY);
    
    if (keys.length > 0) pipeline.del(keys);
    if (paymentKeys.length > 0) pipeline.del(paymentKeys);
    
    await pipeline.exec();
  } catch (error) {
    console.error('Failed to purge queues:', error);
    throw error;
  }
}
