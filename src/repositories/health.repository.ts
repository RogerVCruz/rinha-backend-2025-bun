import sql from '../infra/db';

export type ProcessorType = 'default' | 'fallback';

export interface ProcessorHealth {
  processor_name: ProcessorType;
  is_failing: boolean;
  min_response_time: number;
  last_checked_at: Date;
}

export async function getHealthStatus(): Promise<ProcessorHealth[]> {
  return sql`SELECT * FROM processor_health` as Promise<ProcessorHealth[]>;
}

export async function updateHealthStatus(
  processorName: ProcessorType, 
  isFailing: boolean, 
  minResponseTime: number
) {
  await sql`
    INSERT INTO processor_health (processor_name, is_failing, min_response_time, last_checked_at)
    VALUES (${processorName}, ${isFailing}, ${minResponseTime}, NOW() AT TIME ZONE 'UTC')
    ON CONFLICT (processor_name) DO UPDATE
    SET is_failing = EXCLUDED.is_failing,
        min_response_time = EXCLUDED.min_response_time,
        last_checked_at = EXCLUDED.last_checked_at;
  `;
}