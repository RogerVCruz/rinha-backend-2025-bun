import redis from '../infra/redis';

export class CacheService {
  private static readonly SUMMARY_TTL = 30;
  private static readonly FILTERED_SUMMARY_TTL = 5; // Shorter TTL for date-filtered queries

  static getSummaryKey(from?: string, to?: string): string {
    return `summary:${from || 'all'}:${to || 'all'}`;
  }

  static async getSummary(from?: string, to?: string): Promise<any[] | null> {
    try {
      const key = this.getSummaryKey(from, to);
      const cached = await redis.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.warn('Cache read failed for summary:', error);
      return null;
    }
  }

  static async setSummary(data: any[], from?: string, to?: string): Promise<void> {
    try {
      const key = this.getSummaryKey(from, to);
      const ttl = (from && to) ? this.FILTERED_SUMMARY_TTL : this.SUMMARY_TTL;
      await redis.set(key, JSON.stringify(data), { EX: ttl });
    } catch (error) {
      console.warn('Cache write failed for summary:', error);
    }
  }

  static async invalidateSummary(): Promise<void> {
    try {
      await Promise.all([
        redis.del('summary:all:all'),
        redis.del('summary:undefined:undefined')
      ]);
    } catch (error) {
      console.warn('Cache invalidation failed:', error);
    }
  }
}