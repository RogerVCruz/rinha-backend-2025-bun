import { Elysia } from 'elysia';
import { payments } from './routes/payments';
import { startHealthCheck } from './services/health-check';
import { startPaymentWorker } from './services/payment-worker';

startHealthCheck();
startPaymentWorker();

const app = new Elysia()
  .use(payments)
  .listen(9999);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);