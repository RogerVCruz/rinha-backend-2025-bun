import * as paymentsRepository from '../repositories/payments.repository';

async function checkHealth() {
  console.log('Checking health of payment processors...');
  try {
    const [defaultHealthRes, fallbackHealthRes] = await Promise.all([
      fetch('http://payment-processor-default:8080/payments/service-health'),
      fetch('http://payment-processor-fallback:8080/payments/service-health'),
    ]);

    const [defaultHealthJson, fallbackHealthJson] = await Promise.all([
        defaultHealthRes.json(),
        fallbackHealthRes.json(),
    ]);

    await Promise.all([
      paymentsRepository.updateHealthStatus('default', defaultHealthJson.failing, defaultHealthJson.minResponseTime),
      paymentsRepository.updateHealthStatus('fallback', fallbackHealthJson.failing, fallbackHealthJson.minResponseTime),
    ]);

    console.log('Health check finished.');
  } catch (error) {
    console.error('Error checking health:', error);
  }
}

export function startHealthCheck() {
    setInterval(checkHealth, 5000);
}