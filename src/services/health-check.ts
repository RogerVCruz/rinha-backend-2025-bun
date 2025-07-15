import * as paymentsRepository from '../repositories/payments.repository';
import redis from '../infra/redis';

interface HealthStatus {
  default: { isFailing: boolean; minResponseTime: number };
  fallback: { isFailing: boolean; minResponseTime: number };
}

let healthCache: HealthStatus = {
  default: { isFailing: true, minResponseTime: 0 },
  fallback: { isFailing: true, minResponseTime: 0 }
};

export function getHealthStatusSync(): HealthStatus {
  return healthCache;
}

async function tryAcquireLock(): Promise<boolean> {
  try {
    const result = await redis.set('health_check_lock', '1', {
      PX: 4000,
      NX: true
    });
    return result === 'OK';
  } catch (error) {
    console.warn('Health check lock acquisition failed:', error);
    return false;
  }
}

async function getCachedHealth(): Promise<HealthStatus | null> {
  try {
    const cached = await redis.get('health_status');
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.warn('Failed to get cached health:', error);
    return null;
  }
}

async function setCachedHealth(health: HealthStatus): Promise<void> {
  try {
    await redis.set('health_status', JSON.stringify(health), { EX: 15 }); // Longer cache TTL
  } catch (error) {
    console.warn('Failed to cache health status:', error);
  }
}

async function getHealthData(url: string): Promise<{ failing: boolean; minResponseTime: number } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    
    const response = await fetch(url, { 
      signal: controller.signal,
      headers: { 'Connection': 'close' }
    });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    return null;
  }
}

async function checkHealth() {
  const cached = await getCachedHealth();
  if (cached) {
    healthCache = cached;
    return;
  }

  const hasLock = await tryAcquireLock();
  if (!hasLock) {
    return;
  }

  const [defaultHealth, fallbackHealth] = await Promise.all([
    getHealthData('http://payment-processor-default:8080/payments/service-health'),
    getHealthData('http://payment-processor-fallback:8080/payments/service-health'),
  ]);

  const defaultFailing = !defaultHealth || defaultHealth.failing;
  const fallbackFailing = !fallbackHealth || fallbackHealth.failing;

  const newHealth: HealthStatus = {
    default: {
      isFailing: defaultFailing,
      minResponseTime: defaultHealth?.minResponseTime ?? 0
    },
    fallback: {
      isFailing: fallbackFailing,
      minResponseTime: fallbackHealth?.minResponseTime ?? 0
    }
  };

  healthCache = newHealth;
  
  await setCachedHealth(newHealth);

  await Promise.all([
    paymentsRepository.updateHealthStatus('default', defaultFailing, defaultHealth?.minResponseTime ?? 0),
    paymentsRepository.updateHealthStatus('fallback', fallbackFailing, fallbackHealth?.minResponseTime ?? 0)
  ]);
}

export function startHealthCheck() {
    // Immediate check on startup
    checkHealth();
    // Check every 3 seconds instead of 2 (closer to 5s rate limit)
    setInterval(checkHealth, 3000);
}