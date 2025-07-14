import sql from '../db';

async function checkHealth() {
  console.log('Checking health of payment processors...');
  try {
    const [defaultHealth, fallbackHealth] = await Promise.all([
      fetch('http://payment-processor-default:8080/payments/service-health'),
      fetch('http://payment-processor-fallback:8080/payments/service-health'),
    ]);

    const [defaultHealthJson, fallbackHealthJson] = await Promise.all([
        defaultHealth.json(),
        fallbackHealth.json(),
    ]);

    await sql`
      INSERT INTO processor_health (processor_name, is_failing, min_response_time, last_checked_at)
      VALUES ('default', ${defaultHealthJson.failing}, ${defaultHealthJson.minResponseTime}, NOW()),
             ('fallback', ${fallbackHealthJson.failing}, ${fallbackHealthJson.minResponseTime}, NOW())
      ON CONFLICT (processor_name) DO UPDATE
      SET is_failing = EXCLUDED.is_failing,
          min_response_time = EXCLUDED.min_response_time,
          last_checked_at = EXCLUDED.last_checked_at;
    `;

    console.log('Health check finished.');
  } catch (error) {
    console.error('Error checking health:', error);
  }
}

export function startHealthCheck() {
    setInterval(checkHealth, 5000);
}
