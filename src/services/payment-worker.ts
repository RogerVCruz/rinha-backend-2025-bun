/**
 * Este ficheiro contém a lógica de negócio para processar pagamentos.
 * Foi ajustado para funcionar com a implementação de fila atómica e segura.
 * * FICHEIRO: src/services/payments.service.js (ou .ts)
 */

import * as paymentsRepository from '../repositories/payments.repository';
import { getHealthStatusSync } from './health-check';
import redis from '../infra/redis';
// Importa as funções da fila refatorada
import * as redisQueue from './redis-queue';

/**
 * Tenta adquirir um lock distribuído no Redis para garantir que apenas um worker
 * processe a fila por vez.
 */
async function tryAcquireWorkerLock(): Promise<boolean> {
  try {
    // TTL de 15 segundos para o lock, um valor seguro para a Rinha
    const result = await redis.set('worker_lock', '1', {
      PX: 15000,
      NX: true
    });
    return result === 'OK';
  } catch (error) {
    console.warn('Falha ao adquirir o lock do worker:', error);
    return false;
  }
}

/**
 * Função atómica para finalizar um pagamento.
 * Primeiro, regista a transação na fonte da verdade (base de dados).
 * Depois, remove o item da fila de processamento no Redis.
 * * @param rawItem - Opcional. O item original (string) da fila. Necessário para
 * pagamentos processados pelo worker para removê-los da lista 'processing'.
 */
async function _finalizePayment(
  correlationId: string,
  amount: number,
  processor: 'default' | 'fallback',
  rawItem?: string // O rawItem é opcional para suportar o fluxo da API
): Promise<void> {
  try {
    // 1. Salvar na base de dados (fonte da verdade)
    await paymentsRepository.createTransaction(correlationId, amount, processor);
    
    // 2. Marcar como processado no Redis
    // A nova função `markAsProcessed` lida com a remoção da lista 'processing' se rawItem for fornecido.
    await redisQueue.markAsProcessed(correlationId, rawItem as string);

  } catch (dbError) {
    console.error(`Falha na transação da BD para ${correlationId}:`, dbError);
    // Se a BD falhar, o erro deve ser propagado para que o item seja reenviado.
    throw dbError;
  }
}

/**
 * Tenta realizar um pagamento através de um dos processadores externos.
 * Inclui um timeout de 3 segundos.
 */
const attemptPayment = async (
  processor: 'default' | 'fallback',
  body: { correlationId: string; amount: number }
): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    // Recomenda-se remover 'Connection: close' para usar keep-alive e melhorar a performance
    const response = await fetch(`http://payment-processor-${processor}:8080/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, requestedAt: new Date().toISOString() }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    // Captura erros de fetch, incluindo os timeouts do AbortController
    return false;
  }
};

/**
 * Lógica de processamento para um único pagamento retirado da fila pelo worker.
 * * @param payment - O objeto de pagamento deserializado.
 * @param rawItem - A string original do item da fila.
 */
async function processPayment(
    payment: redisQueue.QueueItem, 
    rawItem: string
): Promise<boolean> {
  const health = getHealthStatusSync();
  const processors: Array<'default' | 'fallback'> = [];

  if (!health.default.isFailing) processors.push('default');
  if (!health.fallback.isFailing) processors.push('fallback');

  for (const processor of processors) {
    if (await attemptPayment(processor, {
      correlationId: payment.correlationId,
      amount: payment.amount
    })) {
      try {
        // Sucesso! Finaliza o pagamento, passando o rawItem para remoção da fila 'processing'.
        await _finalizePayment(payment.correlationId, payment.amount, processor, rawItem);
        return true;
      } catch (error) {
        // A finalização falhou (ex: BD offline). O pagamento deve ser reenviado.
        console.warn(`Finalização do pagamento falhou para ${payment.correlationId}, será reenviado.`, error);
        return false;
      }
    }
  }

  return false; // Nenhum processador teve sucesso.
}

/**
 * Função principal do worker. Pega itens da fila principal e da fila de retries,
 * e os processa.
 * AJUSTADO PARA A NOVA FILA.
 */
async function processQueue() {
  const hasLock = await tryAcquireWorkerLock();
  if (!hasLock) {
    // Outra instância está a processar. Agenda a próxima verificação e sai.
    setTimeout(processQueue, 500);
    return;
  }

  try {
    // 1. Pega itens de ambas as filas de forma segura.
    // A implementação da fila já move os itens para uma lista 'processing'.
    const [mainQueueItems, retryItems] = await Promise.all([
      redisQueue.getFromQueue(100),
      redisQueue.getRetryableItems()
    ]);

    const allItems = [...mainQueueItems, ...retryItems];
    if (allItems.length === 0) {
        // Se não há itens, não há necessidade de esperar o ciclo completo.
        // Libera o lock e agenda a próxima execução mais cedo.
        await redis.del('worker_lock'); 
        setTimeout(processQueue, 200); // Verifica novamente em 200ms
        return;
    }


    // 2. Processa cada item.
    for (const item of allItems) {
      // Passa o item deserializado (item.parsed) e o original (item.raw)
      const success = await processPayment(item.parsed, item.raw);

      if (!success) {
        // Se o processamento falhou, adiciona à fila de retry.
        // A nova função `addToRetryQueue` só precisa do item original.
        await redisQueue.addToRetryQueue(item.raw);
      }
      // Se teve sucesso, `_finalizePayment` já chamou `markAsProcessed`,
      // que removeu o item da lista 'processing'. Nenhuma ação extra é necessária.
    }
  } catch (error) {
    console.warn('Ocorreu um erro inesperado durante o processamento da fila:', error);
  } finally {
    // Garante que o lock seja libertado antes de agendar a próxima execução.
    await redis.del('worker_lock');
    // Agenda a próxima execução após o ciclo atual terminar.
    setTimeout(processQueue, 500);
  }
}


/**
 * Ponto de entrada da API para processar um pagamento de forma assíncrona.
 * Tenta o pagamento imediatamente e, se falhar, enfileira para o worker.
 * Esta função NÃO precisa de grandes alterações.
 */
export async function processPaymentAsync(
  correlationId: string,
  amount: number
): Promise<void> {
  try {
    const health = getHealthStatusSync();
    const body = { correlationId, amount };

    // Tenta o processador 'default'
    if (!health.default.isFailing && await attemptPayment("default", body)) {
      try {
        // Sucesso! Finaliza sem passar o rawItem, pois não veio da fila.
        await _finalizePayment(correlationId, amount, "default");
        return; 
      } catch (finalizationError) {
        // O pagamento foi feito, mas a BD falhou. Enfileira para garantir o registo.
        await redisQueue.addToQueue(correlationId, amount);
        return;
      }
    }

    // Tenta o processador 'fallback'
    if (!health.fallback.isFailing && await attemptPayment("fallback", body)) {
       try {
        await _finalizePayment(correlationId, amount, "fallback");
        return;
      } catch (finalizationError) {
        await redisQueue.addToQueue(correlationId, amount);
        return;
      }
    }

    // Todos os processadores falharam ou estavam indisponíveis, enfileira para o worker.
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

/**
 * Inicia o worker de pagamentos.
 */
export function startPaymentWorker() {
  console.log('Worker de pagamentos iniciado.');
  // Inicia o primeiro ciclo do loop de processamento.
  processQueue();
}
