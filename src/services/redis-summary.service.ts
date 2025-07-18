import redis from '../infra/redis';
import sql from '../infra/db';

export type ProcessorType = 'default' | 'fallback';

export interface SummaryData {
  processor: ProcessorType;
  total_requests: number;
  total_amount: number;
}

export class RedisSummaryService {
  private static getProcessorKey(processor: ProcessorType): string {
    return `summary:processor:${processor}`;
  }

  static async incrementCounters(processor: ProcessorType, amount: number): Promise<void> {
    const key = this.getProcessorKey(processor);
    
    try {
      const multi = redis.multi();
      multi.hIncrBy(key, 'total_requests', 1);
      multi.hIncrByFloat(key, 'total_amount', amount);
      await multi.exec();
    } catch (error) {
      console.warn('Failed to update Redis summary counters:', error);
      // Continue - DB is source of truth
    }
  }

  static async incrementManyCounters(counters: Record<ProcessorType, { requests: number, amount: number }>): Promise<void> {
    try {
      const multi = redis.multi();
      for (const processor in counters) {
        const key = this.getProcessorKey(processor as ProcessorType);
        const { requests, amount } = counters[processor as ProcessorType];

        if (requests > 0) {
          multi.hIncrBy(key, 'total_requests', requests);
          multi.hIncrByFloat(key, 'total_amount', amount);
        }
      }
      await multi.exec();
    } catch (error) {
      console.warn('Failed to bulk update Redis summary counters:', error);
    }
  }

  static async getSummary(): Promise<SummaryData[]> {
    try {
      const processors: ProcessorType[] = ['default', 'fallback'];
      const results = await Promise.all(
        processors.map(processor => {
          const key = this.getProcessorKey(processor);
          return redis.hGetAll(key);
        })
      );
      
      return processors.map((processor, index) => {
        const data = results[index];
        
        if (!data || Object.keys(data).length === 0) {
          return {
            processor,
            total_requests: 0,
            total_amount: 0
          };
        }
        
        return {
          processor,
          total_requests: parseInt(data.total_requests || '0', 10),
          total_amount: parseFloat(data.total_amount || '0')
        };
      });
    } catch (error) {
      console.warn('Failed to get Redis summary, falling back to DB:', error);
      throw error; // Let caller handle fallback
    }
  }

  static async rebuildFromDatabase(): Promise<void> {
    try {
      console.log('Rebuilding Redis summary from database...');
      
      // Clear existing counters
      await this.clearCounters();
      
      // Get aggregated data from DB
      const result = await sql`
        SELECT 
          processor,
          COUNT(*)::int as total_requests,
          COALESCE(SUM(amount), 0)::numeric as total_amount
        FROM transactions 
        GROUP BY processor
      `;
      
      // Update Redis with DB data
      const multi = redis.multi();
      
      for (const row of result as any[]) {
        const key = this.getProcessorKey(row.processor);
        multi.hSet(key, {
          total_requests: row.total_requests.toString(),
          total_amount: row.total_amount.toString()
        });
      }
      
      await multi.exec();
      console.log('Redis summary rebuild completed');
    } catch (error) {
      console.error('Failed to rebuild Redis summary:', error);
      throw error;
    }
  }

  static async clearCounters(): Promise<void> {
    try {
      const processors: ProcessorType[] = ['default', 'fallback'];
      const keys = processors.map(p => this.getProcessorKey(p));
      
      if (keys.length > 0) {
        await redis.del(keys);
      }
    } catch (error) {
      console.warn('Failed to clear Redis summary counters:', error);
    }
  }

  static async ensureCountersExist(): Promise<void> {
    try {
      const processors: ProcessorType[] = ['default', 'fallback'];
      
      for (const processor of processors) {
        const key = this.getProcessorKey(processor);
        // Only set if key doesn't exist
        await redis.hSetNX(key, 'total_requests', '0');
        await redis.hSetNX(key, 'total_amount', '0');
      }
    } catch (error) {
      console.warn('Failed to ensure Redis counters exist:', error);
    }
  }
}