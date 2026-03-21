import type { DatabaseService } from './database';

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;

  private runningJobs = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly runner: (jobId: string) => Promise<void>,
    private readonly onStateChange: () => void,
  ) {}

  async start() {
    await this.database.markMissedJobs(new Date().toISOString());
    this.timer = setInterval(() => {
      void this.tick();
    }, 15_000);
    await this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    const now = new Date().toISOString();
    const dueJobs = this.database.getDueJobs(now);
    const uniqueDueJobIds = Array.from(new Set(dueJobs.map((job) => job.id)));

    for (const jobId of uniqueDueJobIds) {
      if (this.runningJobs.has(jobId)) {
        continue;
      }

      this.runningJobs.add(jobId);
      try {
        await this.runner(jobId);
      } finally {
        this.runningJobs.delete(jobId);
      }
    }

    this.onStateChange();
  }
}
