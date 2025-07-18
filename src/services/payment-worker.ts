import * as paymentsRepository from '../repositories/payments.repository';
import { getHealthStatusSync } from './health-check';
import redis from '../infra/redis';
import * as redisQueue from './redis-queue';

// Tipos para maior clareza
type Processor = 'default' | 'fallback';
type PaymentResult = { status: 'fulfilled' | 'rejected'; value: any; }

// Otimizado: Tenta adquirir lock com menos frequência se ocioso
async function tryAcquireWorkerLock(): Promise<boolean> {
  const result = await redis.set('worker_lock', '1', { PX: 15000, NX: true });
  return result === 'OK';
}

// Otimizado: Finaliza múltiplos pagamentos em uma única transação
async function finalizeSuccessfulPayments(
  successful: { correlationId: string; amount: number; processor: Processor; raw: string }[]
): Promise<void> {
  if (successful.length === 0) return;

  const transactions = successful.map(p => ({
    correlationId: p.correlationId,
    amount: p.amount,
    processor: p.processor,
  }));

  try {
    await paymentsRepository.createManyTransactions(transactions);
    await redisQueue.markManyAsProcessed(successful.map(p => ({ correlationId: p.correlationId, raw: p.raw })));
  } catch (dbError) {
    console.error('Falha na transação em lote da BD:', dbError);
    // Se a BD falhar, todos os itens devem ser reenviados para evitar perda de dados
    await redisQueue.addManyToRetryQueue(successful.map(p => p.raw));
  }
}

// Otimizado: Usa um único AbortController para o lote
const attemptPayment = async (
  processor: Processor,
  body: { correlationId: string; amount: number },
  controller: AbortController
): Promise<boolean> => {
  try {
    const response = await fetch(`http://payment-processor-${processor}:8080/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, requestedAt: new Date().toISOString() }),
      signal: controller.signal,
    });
    return response.ok;
  } catch (error: any) {
    console.log(`[WORKER-DEBUG] Payment to ${processor} failed:`, error.message);
    return false;
  }
};

// Otimizado: Processa um único item, mas retorna dados para processamento em lote
async function processPayment(payment: redisQueue.QueueItem, rawItem: string): Promise<{ success: boolean; processor?: Processor }> {
  const health = getHealthStatusSync();
  const processors: Processor[] = [];

  console.log(`[WORKER-DEBUG] Health status:`, health);
  
  // Forçar processors disponíveis para debug
  processors.push('default');
  processors.push('fallback');
  
  // if (!health.default.isFailing) processors.push('default');
  // if (!health.fallback.isFailing) processors.push('fallback');
  
  console.log(`[WORKER-DEBUG] Available processors:`, processors);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // Aumentado para 8s para acomodar fallback

  for (const processor of processors) {
    if (await attemptPayment(processor, payment, controller)) {
      clearTimeout(timeoutId);
      return { success: true, processor };
    }
  }

  clearTimeout(timeoutId);
  return { success: false };
}

// Otimizado: Função principal do worker com processamento em lote (SEM LOCK para múltiplos workers)
async function processQueue() {
  // Removido lock para permitir múltiplos workers paralelos
  // const hasLock = await tryAcquireWorkerLock();
  // if (!hasLock) {
  //   setTimeout(processQueue, 50); 
  //   return;
  // }

  let delayNextLoop = 100; // Reduzido delay para processamento mais agressivo

  try {
    const [mainQueueItems, retryItems] = await Promise.all([
      redisQueue.getFromQueue(20), // Batch otimizado para recursos limitados
      redisQueue.getRetryableItems(),
    ]);

    const allItems = [...mainQueueItems, ...retryItems];

    if (allItems.length > 0) {
      const processingPromises = allItems.map(item => processPayment(item.parsed, item.raw));
      const results = await Promise.allSettled(processingPromises);

      const successfulPayments: any[] = [];
      const failedItems: string[] = [];

      results.forEach((result, index) => {
        const item = allItems[index];
        if (result.status === 'fulfilled' && result.value.success) {
          successfulPayments.push({ ...item.parsed, processor: result.value.processor, raw: item.raw });
        } else {
          failedItems.push(item.raw);
        }
      });

      await Promise.all([
        finalizeSuccessfulPayments(successfulPayments),
        redisQueue.addManyToRetryQueue(failedItems),
      ]);

      delayNextLoop = 0; // Processa o próximo lote imediatamente
    }
  } catch (error) {
    console.warn('Erro inesperado no loop principal do worker:', error);
    delayNextLoop = 1000;
  } finally {
    // Removido lock cleanup - agora múltiplos workers rodam em paralelo
    setTimeout(processQueue, delayNextLoop); // Agora sem lock, múltiplos workers podem rodar
  }
}

// Função de API permanece a mesma, mas pode ser otimizada se necessário
export async function processPaymentAsync(correlationId: string, amount: number): Promise<void> {
    try {
        const health = getHealthStatusSync();
        const body = { correlationId, amount };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const tryProcessor = async (processor: Processor): Promise<boolean> => {
            if (!health[processor].isFailing && await attemptPayment(processor, body, controller)) {
                clearTimeout(timeoutId); // Limpa o timeout global se sucesso
                try {
                    await paymentsRepository.createTransaction(correlationId, amount, processor);
                    await redisQueue.markAsProcessed(correlationId);
                    return true;
                } catch (finalizationError) {
                    await redisQueue.addToQueue(correlationId, amount);
                    return true; // Considerado "tratado" pois foi para a fila de retentativa
                }
            }
            return false;
        };

        if (await tryProcessor('default')) return;
        if (await tryProcessor('fallback')) return;

        // Se ambos falharem, limpa o timeout e adiciona à fila
        clearTimeout(timeoutId);
        await redisQueue.addToQueue(correlationId, amount);

    } catch (error) {
        console.error("Falha crítica no processamento do pagamento, enfileirando para o worker:", error);
        try {
            await redisQueue.addToQueue(correlationId, amount);
        } catch (queueError) {
            console.error("CRÍTICO: Falha ao enfileirar pagamento após erro de processamento:", queueError);
        }
    }
}

export function startPaymentWorker() {
  console.log('Worker de pagamentos otimizado iniciado.');
  processQueue();
}
