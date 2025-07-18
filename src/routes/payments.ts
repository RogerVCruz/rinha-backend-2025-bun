import { Elysia, t } from 'elysia';
import { createPayment, getPaymentsSummary, purgePayments, rebuildSummaryCache } from '../controllers/payments.controller';

export const payments = new Elysia()
  .get("/payments-summary", getPaymentsSummary, {
    query: t.Object({
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
    })
  })
  .post("/payments", createPayment, {
    body: t.Object({
        correlationId: t.String(),
        amount: t.Number(),
    })
  })
  .post("/purge-payments", purgePayments)
  .post("/rebuild-summary-cache", rebuildSummaryCache);