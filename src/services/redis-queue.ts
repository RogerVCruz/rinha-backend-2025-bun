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
 * Argumentos (ARGV):
 * - ARGV[1]: Timestamp atual (Date.now()) para buscar itens com score menor ou igual.
 * Retorna:
 * - Uma lista de itens que estavam prontos para serem reprocessados.
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
 * Usa um set com NX para garantir que o mesmo correlationId não seja enfileirado duas vezes.
 */
export async function addToQueue(correlationId: string, amount: number): Promise<void> {
  const item: QueueItem = {
    correlationId,
    amount,
    retryCount: 0,
    nextRetryAt: Date.now()
  };
  
  try {
    // Garante a idempotência na adição à fila
    const added = await redis.set(`queue_item:${correlationId}`, '1', { NX: true, EX: 3600 });
    if (added === 'OK') {
      await redis.lPush(QUEUE_KEY, JSON.stringify(item));
    }
  } catch (error) {
    console.error('Failed to add to queue:', error);
    throw error;
  }
}

/**
 * Pega itens da fila principal de forma segura, movendo-os para uma fila de processamento.
 * Isso previne a perda de dados se o worker falhar.
 */
export async function getFromQueue(limit = 20): Promise<DequeuedItem[]> {
  try {
    const items: DequeuedItem[] = [];
    for (let i = 0; i < limit; i++) {
      // LMOVE move atomicamente o item da fila principal para a de processamento
      const rawItem = await redis.lMove(QUEUE_KEY, PROCESSING_KEY, 'RIGHT', 'LEFT');
      if (rawItem) {
        try {
          items.push({ raw: rawItem, parsed: JSON.parse(rawItem) });
        } catch (parseError) {
          console.warn('Failed to parse queue item, returning to queue:', rawItem, parseError);
          // Se o item for inválido, devolve para o final da fila de processamento para análise manual
          await redis.lPush(PROCESSING_KEY, rawItem);
        }
      } else {
        // A fila está vazia
        break;
      }
    }
    return items;
  } catch (error) {
    console.error('Failed to get from queue:', error);
    return [];
  }
}

/**
 * Pega itens da fila de retry de forma atômica usando um script Lua.
 */
export async function getRetryableItems(): Promise<DequeuedItem[]> {
  try {
    const now = Date.now();
    // EVAL executa o script Lua de forma atômica
    const rawItems = await redis.eval(GET_AND_REMOVE_RETRY_ITEMS_SCRIPT, {
      keys: [RETRY_QUEUE_KEY],
      arguments: [String(now)],
    }) as string[];

    if (rawItems && rawItems.length > 0) {
      // Move os itens recuperados para a fila de processamento
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
 * Remove o item da fila de processamento e a chave de controle de duplicidade.
 * @param correlationId - O ID de correlação do pagamento.
 * @param rawItem - O item stringificado original para remover da lista de processamento.
 */
export async function markAsProcessed(correlationId: string, rawItem: string): Promise<void> {
  try {
    const pipeline = redis.multi();
    // Remove o item da lista de processamento
    pipeline.lRem(PROCESSING_KEY, 1, rawItem);
    // Remove a chave que previne a re-inserção na fila
    pipeline.del(`queue_item:${correlationId}`);
    // Opcional: Marca como processado para consultas futuras
    pipeline.set(`payment_processed:${correlationId}`, '1', { EX: 3600 });
    
    await pipeline.exec();
  } catch (error) {
    console.error(`Failed to mark as processed for ${correlationId}:`, error);
  }
}

/**
 * Adiciona um item à fila de retentativas (Sorted Set) com backoff exponencial.
 * @param rawItem - O item stringificado original para remover da lista de processamento.
 */
export async function addToRetryQueue(rawItem: string): Promise<void> {
  try {
    const item: QueueItem = JSON.parse(rawItem);
    const maxRetries = 10;
    
    // Primeiro, remove da fila de processamento
    await redis.lRem(PROCESSING_KEY, 1, rawItem);

    if (item.retryCount >= maxRetries) {
      console.warn(`Payment ${item.correlationId} reached max retries.`);
      await redis.del(`queue_item:${item.correlationId}`);
      await redis.set(`payment_failed:${item.correlationId}`, '1', { EX: 86400 }); // 24h
      return;
    }
    
    // Calcula o delay com backoff exponencial (5ms, 10ms, 20ms, 40ms...) com teto de 300s
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
 * Limpa todas as filas e chaves relacionadas. Apenas para testes.
 * CUIDADO: O uso de KEYS não é recomendado em produção.
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
