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

    for (const job of dueJobs) {
      if (this.runningJobs.has(job.id)) {
        continue;
      }

      this.runningJobs.add(job.id);
      try {
        await this.runner(job.id);
      } finally {
        this.runningJobs.delete(job.id);
      }
    }

    this.onStateChange();
  }
}
