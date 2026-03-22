import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import type { Database as SqlDatabase, SqlJsStatic, SqlValue } from 'sql.js';
import type {
  AppSnapshot,
  ComposerInput,
  DashboardStats,
  DraftRecord,
  PlatformAccount,
  PlatformDefinitionMap,
  PublishJob,
} from '../../src/shared/types';

const require = createRequire(
  typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url),
);

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class DatabaseService {
  private sql!: SqlJsStatic;

  private db!: SqlDatabase;

  private readonly dbPath: string;

  constructor(
    baseDir: string,
    private readonly platformDefinitions: PlatformDefinitionMap,
  ) {
    this.dbPath = path.join(baseDir, 'social-desk.sqlite');
  }

  async initialize() {
    await mkdir(path.dirname(this.dbPath), { recursive: true });

    this.sql = await initSqlJs({
      locateFile: (file: string) => {
        try {
          return require.resolve(`sql.js/dist/${file}`);
        } catch {
          return path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm')), file);
        }
      },
    });

    const existing = await readFile(this.dbPath).catch(() => null);
    this.db = existing ? new this.sql.Database(existing) : new this.sql.Database();
    this.bootstrapSchema();
    await this.persist();
  }

  async persist() {
    const data = this.db.export();
    await writeFile(this.dbPath, Buffer.from(data));
  }

  private bootstrapSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_validated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        assets_json TEXT NOT NULL,
        selected_platforms_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        draft_id TEXT,
        payload_json TEXT NOT NULL,
        scheduled_for TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        results_json TEXT NOT NULL
      );
    `);
  }

  private query<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []) {
    const statement = this.db.prepare(sql, params);
    const rows: T[] = [];

    while (statement.step()) {
      rows.push(statement.getAsObject() as T);
    }

    statement.free();
    return rows;
  }

  async upsertAccount(account: PlatformAccount) {
    this.db.run(
      `
        INSERT INTO accounts (id, platform, label, status, detail, created_at, updated_at, last_validated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          status = excluded.status,
          detail = excluded.detail,
          updated_at = excluded.updated_at,
          last_validated_at = excluded.last_validated_at
      `,
      [
        account.id,
        account.platform,
        account.label,
        account.status,
        account.detail,
        account.createdAt,
        account.updatedAt,
        account.lastValidatedAt,
      ],
    );
    await this.persist();
    return account;
  }

  async deleteAccount(accountId: string) {
    this.db.run(`DELETE FROM accounts WHERE id = ?`, [accountId]);
    await this.persist();
  }

  listAccounts() {
    return this.query<{
      id: string;
      platform: string;
      label: string;
      status: string;
      detail: string;
      created_at: string;
      updated_at: string;
      last_validated_at: string | null;
    }>(`SELECT * FROM accounts ORDER BY created_at DESC`).map((row) => ({
      id: row.id,
      platform: row.platform as PlatformAccount['platform'],
      label: row.label,
      status: row.status as PlatformAccount['status'],
      detail: row.detail,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastValidatedAt: row.last_validated_at,
    }));
  }

  getAccount(accountId: string) {
    return this.listAccounts().find((account) => account.id === accountId) ?? null;
  }

  getLatestConnectedAccount(platform: PlatformAccount['platform']) {
    return this.listAccounts().find(
      (account) => account.platform === platform && account.status === 'connected',
    );
  }

  async saveDraft(input: ComposerInput) {
    const timestamp = nowIso();
    const draft: DraftRecord = {
      id: randomId('draft'),
      body: input.body,
      assets: input.assets,
      selectedPlatforms: input.selectedPlatforms,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.db.run(
      `
        INSERT INTO drafts (id, body, assets_json, selected_platforms_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        draft.id,
        draft.body,
        JSON.stringify(draft.assets),
        JSON.stringify(draft.selectedPlatforms),
        draft.createdAt,
        draft.updatedAt,
      ],
    );

    await this.persist();
    return draft;
  }

  listDrafts() {
    return this.query<{
      id: string;
      body: string;
      assets_json: string;
      selected_platforms_json: string;
      created_at: string;
      updated_at: string;
    }>(`SELECT * FROM drafts ORDER BY updated_at DESC`).map((row) => ({
      id: row.id,
      body: row.body,
      assets: parseJson<DraftRecord['assets']>(row.assets_json, []),
      selectedPlatforms: parseJson<DraftRecord['selectedPlatforms']>(
        row.selected_platforms_json,
        [],
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async createJob(payload: ComposerInput, scheduledFor: string | null, status: PublishJob['status']) {
    const timestamp = nowIso();
    const job: PublishJob = {
      id: randomId('job'),
      draftId: null,
      payload,
      scheduledFor,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
      results: [],
    };

    this.db.run(
      `
        INSERT INTO jobs (id, draft_id, payload_json, scheduled_for, status, created_at, updated_at, finished_at, results_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        job.id,
        job.draftId,
        JSON.stringify(job.payload),
        job.scheduledFor,
        job.status,
        job.createdAt,
        job.updatedAt,
        job.finishedAt,
        JSON.stringify(job.results),
      ],
    );

    await this.persist();
    return job;
  }

  async updateJob(job: PublishJob) {
    this.db.run(
      `
        UPDATE jobs
        SET payload_json = ?, scheduled_for = ?, status = ?, updated_at = ?, finished_at = ?, results_json = ?
        WHERE id = ?
      `,
      [
        JSON.stringify(job.payload),
        job.scheduledFor,
        job.status,
        job.updatedAt,
        job.finishedAt,
        JSON.stringify(job.results),
        job.id,
      ],
    );
    await this.persist();
    return job;
  }

  async clearHistory() {
    this.db.run(
      `
        DELETE FROM jobs
        WHERE status NOT IN ('pending', 'running')
      `,
    );
    await this.persist();
  }

  getJob(jobId: string) {
    return this.listJobs().find((job) => job.id === jobId) ?? null;
  }

  listJobs() {
    return this.query<{
      id: string;
      draft_id: string | null;
      payload_json: string;
      scheduled_for: string | null;
      status: string;
      created_at: string;
      updated_at: string;
      finished_at: string | null;
      results_json: string;
    }>(`SELECT * FROM jobs ORDER BY created_at DESC`).map((row) => ({
      id: row.id,
      draftId: row.draft_id,
      payload: parseJson<ComposerInput>(row.payload_json, {
        body: '',
        assets: [],
        selectedPlatforms: [],
      }),
      scheduledFor: row.scheduled_for,
      status: row.status as PublishJob['status'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      results: parseJson<PublishJob['results']>(row.results_json, []),
    }));
  }

  getDueJobs(referenceTime: string) {
    return this.listJobs().filter(
      (job) => job.status === 'pending' && job.scheduledFor !== null && job.scheduledFor <= referenceTime,
    );
  }

  async markMissedJobs(referenceTime: string) {
    const due = this.getDueJobs(referenceTime);
    for (const job of due) {
      job.status = 'missed';
      job.updatedAt = referenceTime;
      job.finishedAt = referenceTime;
      job.results = job.payload.selectedPlatforms.map((platform) => ({
        platform,
        status: 'skipped' as const,
        message: 'The desktop app was closed when this job was scheduled to publish.',
        publishedAt: null,
        postUrl: null,
      }));
      await this.updateJob(job);
    }
    return due;
  }

  getSnapshot(): AppSnapshot {
    const accounts = this.listAccounts();
    const drafts = this.listDrafts();
    const jobs = this.listJobs();
    const scheduledJobs = jobs.filter(
      (job) =>
        job.scheduledFor !== null &&
        (job.status === 'pending' || job.status === 'running'),
    );
    const history = jobs.filter((job) => !scheduledJobs.includes(job));
    const stats: DashboardStats = {
      connectedAccounts: accounts.filter((account) => account.status === 'connected').length,
      scheduledCount: scheduledJobs.length,
      publishedCount: history.filter((job) => job.status === 'completed').length,
      failedCount: history.filter((job) => job.status === 'failed' || job.status === 'partial').length,
    };

    return {
      accounts,
      drafts,
      scheduledJobs,
      history,
      platformDefinitions: this.platformDefinitions,
      stats,
      lastUpdatedAt: nowIso(),
    };
  }
}
