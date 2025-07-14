import { Elysia } from 'elysia';
import { payments } from './routes/payments';
import { startHealthCheck } from './services/health-check';

startHealthCheck();

const app = new Elysia()
  .use(payments)
  .listen(9999);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);