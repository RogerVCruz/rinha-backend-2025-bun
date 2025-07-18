import redis from '../infra/redis';
import * as transactionsRepo from './transactions.repository';
import * as pendingPaymentsRepo from './pending-payments.repository';
import * as healthRepo from './health.repository';
import { RedisSummaryService } from '../services/redis-summary.service';

// Re-export for backward compatibility
export const getHealthStatus = healthRepo.getHealthStatus;
export const updateHealthStatus = healthRepo.updateHealthStatus;

export const createTransaction = transactionsRepo.createTransaction;
export const checkPaymentExists = transactionsRepo.checkPaymentExists;
export const createManyTransactions = transactionsRepo.createManyTransactions;
export const getSummary = transactionsRepo.getSummary;

export const addPendingPayment = pendingPaymentsRepo.addPendingPayment;
export const getPendingPayments = pendingPaymentsRepo.getPendingPayments;
export const markPaymentProcessed = pendingPaymentsRepo.markPaymentProcessed;
export const markPaymentFailed = pendingPaymentsRepo.markPaymentFailed;

export async function purgeAllPayments() {
  try {
    // Prioriza a limpeza do Redis. Se falhar, a operação inteira falha.
    await redis.flushAll();
    
    // Prossegue com a limpeza do banco de dados apenas se o Redis for limpo com sucesso.
    await Promise.all([
      transactionsRepo.purgeTransactions(),
      pendingPaymentsRepo.purgePendingPayments(),
    ]);
  } catch (error) {
    console.error('Purge operation failed:', error);
    // Lança o erro para garantir que o chamador saiba que a operação falhou.
    throw new Error('Failed to purge all payments and cache.');
  }
}

// Add helper function to rebuild Redis summary from DB
export async function rebuildSummaryCache() {
  await RedisSummaryService.rebuildFromDatabase();
}