import { Elysia } from 'elysia';
import { payments } from './routes/payments';
import { startHealthCheck } from './services/health-check';
import { startPaymentWorker } from './services/payment-worker';
import sql from './infra/db';
import redis from './infra/redis';

startHealthCheck();
startPaymentWorker();

const app = new Elysia()
  .use(payments)
  .listen(3000);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);

// Graceful shutdown
async function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  try {
    await Promise.all([
      sql.end(),
      redis.disconnect()
    ]);
    console.log('Connections closed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);