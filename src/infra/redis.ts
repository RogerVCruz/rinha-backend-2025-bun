import { createClient } from 'redis';

const redis = createClient({
  url: 'redis://rinha-redis:6379'
});

redis.on('error', () => {
});

redis.connect().catch(() => {
});

export default redis;