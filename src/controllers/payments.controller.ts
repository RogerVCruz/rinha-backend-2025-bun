import * as paymentsRepository from "../repositories/payments.repository";
import { processPaymentAsync } from "../services/payment-worker";
import redis from "../infra/redis";
import * as redisQueue from "../services/redis-queue";

async function isPaymentAlreadyProcessed(
  correlationId: string
): Promise<boolean> {
  try {
    const exists = await redis.exists(`payment:${correlationId}`);
    return exists === 1;
  } catch (error) {
    console.warn("Redis duplicate check failed:", error);
    return false; // Fail open - allow processing if cache is down
  }
}

async function isPaymentInDatabase(correlationId: string): Promise<boolean> {
  try {
    const result = await paymentsRepository.checkPaymentExists(correlationId);
    return result.length > 0;
  } catch (error) {
    console.warn("Database duplicate check failed:", error);
    return false; // Fail open - allow processing if DB check fails
  }
}

async function markPaymentAsProcessed(correlationId: string): Promise<void> {
  try {
    await redis.set(`payment:${correlationId}`, "1", { EX: 3600 }); // 1 hour TTL
  } catch (error) {
    console.warn("Failed to mark payment as processed in cache:", error);
    // Continue execution - DB transaction is the source of truth
  }
}

export const getPaymentsSummary = async ({
  query,
}: {
  query: { from?: string; to?: string };
}) => {
  // Add timeout for database operations
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Summary query timeout')), 50); // 50ms timeout
  });

  try {
    const result = await Promise.race([
      paymentsRepository.getSummary(query.from, query.to),
      timeoutPromise
    ]) as any[];

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
      if (processor === "default" || processor === "fallback") {
        summary[processor as "default" | "fallback"] = {
          totalRequests: Number(row.total_requests),
          totalAmount: Number(row.total_amount),
        };
      }
    }

    return summary;
  } catch (error) {
    console.error('Summary query failed:', error);
    // Return default values on timeout/error
    return {
      default: {
        totalRequests: 0,
        totalAmount: 0,
      },
      fallback: {
        totalRequests: 0,
        totalAmount: 0,
      },
    };
  }
};


export const createPayment = async ({
  body,
  set,
}: {
  body: { correlationId: string; amount: number };
  set: any;
}) => {
  if (
    !body.correlationId ||
    typeof body.correlationId !== "string" ||
    typeof body.amount !== "number"
  ) {
    set.status = 400;
    return { error: "Invalid payload" };
  }

  // // Check for duplicate payment in BOTH cache AND database
  // if (await isPaymentAlreadyProcessed(body.correlationId)) {
  //   set.status = 409;
  //   return { error: "Payment already processed" };
  // }

  // // Double-check in database to prevent race conditions
  // if (await isPaymentInDatabase(body.correlationId)) {
  //   await markPaymentAsProcessed(body.correlationId); // Sync cache
  //   set.status = 409;
  //   return { error: "Payment already processed" };
  // }

  // Add payment to queue for async processing
  try {
    await redisQueue.addToQueue(body.correlationId, body.amount);
    
    // Process payment asynchronously (fire and forget)
    processPaymentAsync(body.correlationId, body.amount).catch((error) => {
      console.error("Async payment processing failed:", error);
    });

    set.status = 202;
    return { message: "Payment accepted for processing", correlationId: body.correlationId };
  } catch (error) {
    set.status = 500;
    return { error: "Failed to queue payment for processing" };
  }
};

export const purgePayments = async () => {
  await paymentsRepository.purgeAllPayments();
  return { message: "All payments purged successfully" };
};

export const rebuildSummaryCache = async () => {
  await paymentsRepository.rebuildSummaryCache();
  return { message: "Summary cache rebuilt successfully" };
};
