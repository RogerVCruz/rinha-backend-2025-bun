import * as paymentsRepository from "../repositories/payments.repository";
import { getHealthStatusSync } from "../services/health-check";
import redis from "../infra/redis";

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
  const result = await paymentsRepository.getSummary(query.from, query.to);

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
};

const attemptPayment = async (
  processor: "default" | "fallback",
  body: { correlationId: string; amount: number }
): Promise<boolean> => {
  try {
    const controller = new AbortController();
    // const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(
      `http://payment-processor-${processor}:8080/payments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({
          ...body,
          requestedAt: new Date().toISOString(),
        }),
        signal: controller.signal,
      }
    );

    // clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(
        `Payment processor ${processor} returned ${response.status}: ${response.statusText}`
      );
    }

    return response.ok;
  } catch (error: any) {
    if (error.name === "AbortError") {
      console.warn(`Payment processor ${processor} timed out`);
    } else {
      console.warn(`Payment processor ${processor} failed:`, error.message);
    }
    return false;
  }
};

export const createPayment = async ({
  body,
}: {
  body: { correlationId: string; amount: number };
}) => {
  // Check for duplicate payment in BOTH cache AND database
  if (await isPaymentAlreadyProcessed(body.correlationId)) {
    return { message: "Payment already processed" };
  }

  // Double-check in database to prevent race conditions
  if (await isPaymentInDatabase(body.correlationId)) {
    await markPaymentAsProcessed(body.correlationId); // Sync cache
    return { message: "Payment already processed" };
  }

  const health = getHealthStatusSync();

  const isDefaultAvailable = !health.default.isFailing;
  const isFallbackAvailable = !health.fallback.isFailing;

  // Try default processor first (lower fees) - SEQUENTIAL for consistency
  if (isDefaultAvailable) {
    try {
      if (await attemptPayment("default", body)) {
        // ATOMIC: Only mark as processed AFTER successful DB transaction
        await paymentsRepository.createTransaction(
          body.correlationId,
          body.amount,
          "default"
        );
        await markPaymentAsProcessed(body.correlationId);
        return { message: "Payment processed successfully" };
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
          body.correlationId,
          body.amount,
          "fallback"
        );
        await markPaymentAsProcessed(body.correlationId);
        return { message: "Payment processed successfully" };
      }
    } catch (error) {
      console.warn("Fallback processor transaction failed:", error);
      // Continue to queueing
    }
  }

  // All processors failed - try to queue for later (with error handling)
  try {
    await paymentsRepository.addPendingPayment(body.correlationId, body.amount);
    return { message: "Payment queued for processing" };
  } catch (error) {
    // If queueing fails, at least return a proper error
    return { message: "Payment failed - all processors unavailable" };
  }
};

export const purgePayments = async () => {
  await paymentsRepository.purgeAllPayments();
  return { message: "All payments purged successfully" };
};
