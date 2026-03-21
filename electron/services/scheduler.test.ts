import { describe, expect, it, vi } from 'vitest';
import { SchedulerService } from './scheduler';

describe('SchedulerService', () => {
  it('runs due jobs and skips duplicates while a job is already running', async () => {
    const database = {
      markMissedJobs: vi.fn().mockResolvedValue([]),
      getDueJobs: vi.fn().mockReturnValue([{ id: 'job-1' }, { id: 'job-1' }]),
    } as any;

    const runner = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerService(database, runner, vi.fn());

    await scheduler.tick();

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('job-1');
  });
});
