import redis from '../infra/redis';
import * as transactionsRepo from './transactions.repository';
import * as pendingPaymentsRepo from './pending-payments.repository';
import * as healthRepo from './health.repository';

// Re-export for backward compatibility
export const getHealthStatus = healthRepo.getHealthStatus;
export const updateHealthStatus = healthRepo.updateHealthStatus;

export const createTransaction = transactionsRepo.createTransaction;
export const checkPaymentExists = transactionsRepo.checkPaymentExists;
export const getSummary = transactionsRepo.getSummary;

export const addPendingPayment = pendingPaymentsRepo.addPendingPayment;
export const getPendingPayments = pendingPaymentsRepo.getPendingPayments;
export const markPaymentProcessed = pendingPaymentsRepo.markPaymentProcessed;
export const markPaymentFailed = pendingPaymentsRepo.markPaymentFailed;

export async function purgeAllPayments() {
  try {
    await Promise.all([
      transactionsRepo.purgeTransactions(),
      pendingPaymentsRepo.purgePendingPayments(),
      redis.flushAll()
    ]);
  } catch (error) {
    console.warn('Full purge failed, trying database only:', error);
    try {
      await Promise.all([
        transactionsRepo.purgeTransactions(),
        pendingPaymentsRepo.purgePendingPayments()
      ]);
    } catch (dbError) {
      console.error('Database purge failed:', dbError);
      throw dbError;
    }
  }
}