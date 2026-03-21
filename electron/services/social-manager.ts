import { rm } from 'node:fs/promises';
import path from 'node:path';
import dayjs from 'dayjs';
import { platformDefinitions, validateComposer, normalizeComposerInput } from '../../src/shared/content';
import type {
  ConnectAccountInput,
  ConnectAccountResult,
  PlatformAccount,
  PlatformPublishResult,
  PublishJob,
  PublishNowInput,
  PublishNowResult,
  SaveDraftInput,
  SaveDraftResult,
  SchedulePostInput,
  SchedulePostResult,
  ValidateAccountInput,
  DisconnectAccountInput,
} from '../../src/shared/types';
import type { DatabaseService } from './database';
import { PlatformRegistry } from './platform-registry';
import type { AccountSecret, SecureStore } from './secure-store';

interface SocialManagerDependencies {
  database: DatabaseService;
  secureStore: SecureStore;
  profilesDir: string;
  onSnapshot: () => void;
}

function nowIso() {
  return new Date().toISOString();
}

export class SocialManager {
  private readonly registry = new PlatformRegistry();

  constructor(private readonly dependencies: SocialManagerDependencies) {}

  getSnapshot() {
    return this.dependencies.database.getSnapshot();
  }

  async connectAccount(input: ConnectAccountInput): Promise<ConnectAccountResult> {
    const adapter = this.registry.get(input.platform);
    const accountId = `account_${crypto.randomUUID()}`;
    const profileDir = path.join(this.dependencies.profilesDir, input.platform, accountId);
    const session = await adapter.connect({ accountId, profileDir });
    const timestamp = nowIso();

    const account: PlatformAccount = {
      id: accountId,
      platform: input.platform,
      label: session.label,
      status: session.status,
      detail: session.detail,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastValidatedAt: timestamp,
    };

    await this.dependencies.database.upsertAccount(account);
    await this.dependencies.secureStore.setAccountSecret({
      accountId,
      platform: input.platform,
      profileDir,
      lastKnownUrl: session.lastKnownUrl,
    });
    this.dependencies.onSnapshot();

    return { account };
  }

  async validateAccount(input: ValidateAccountInput): Promise<ConnectAccountResult> {
    const account = this.dependencies.database.getAccount(input.accountId);
    const secret = this.dependencies.secureStore.getAccountSecret(input.accountId);
    if (!account || !secret) {
      throw new Error('Account not found.');
    }

    const adapter = this.registry.get(account.platform);
    const session = await adapter.validateSession(secret);
    const updated: PlatformAccount = {
      ...account,
      label: session.label,
      status: session.status,
      detail: session.detail,
      updatedAt: nowIso(),
      lastValidatedAt: nowIso(),
    };

    await this.dependencies.database.upsertAccount(updated);
    await this.dependencies.secureStore.setAccountSecret({
      ...secret,
      lastKnownUrl: session.lastKnownUrl,
    });
    this.dependencies.onSnapshot();

    return { account: updated };
  }

  async disconnectAccount(input: DisconnectAccountInput) {
    const secret = this.dependencies.secureStore.getAccountSecret(input.accountId);
    await this.dependencies.database.deleteAccount(input.accountId);
    await this.dependencies.secureStore.removeAccountSecret(input.accountId);

    if (secret) {
      await rm(secret.profileDir, { recursive: true, force: true });
    }

    this.dependencies.onSnapshot();
  }

  async saveDraft(input: SaveDraftInput): Promise<SaveDraftResult> {
    const payload = normalizeComposerInput(input);
    const validation = validateComposer(payload);
    if (!validation.valid) {
      throw new Error(validation.message ?? 'Draft is not valid.');
    }

    const draft = await this.dependencies.database.saveDraft(payload);
    this.dependencies.onSnapshot();
    return { draft };
  }

  async publishNow(input: PublishNowInput): Promise<PublishNowResult> {
    const payload = normalizeComposerInput(input);
    const validation = validateComposer(payload);
    if (!validation.valid) {
      throw new Error(validation.message ?? 'Post is not valid.');
    }

    const job = await this.dependencies.database.createJob(payload, null, 'running');
    await this.executeJob(job.id);
    const completed = this.dependencies.database.getJob(job.id);
    if (!completed) {
      throw new Error('Job could not be reloaded after publishing.');
    }

    return { job: completed };
  }

  async schedulePost(input: SchedulePostInput): Promise<SchedulePostResult> {
    const payload = normalizeComposerInput(input);
    const validation = validateComposer(payload);
    if (!validation.valid) {
      throw new Error(validation.message ?? 'Scheduled post is not valid.');
    }

    if (!dayjs(input.scheduledFor).isValid()) {
      throw new Error('Scheduled time is invalid.');
    }

    if (dayjs(input.scheduledFor).isBefore(dayjs())) {
      throw new Error('Scheduled time must be in the future.');
    }

    const job = await this.dependencies.database.createJob(payload, input.scheduledFor, 'pending');
    this.dependencies.onSnapshot();
    return { job };
  }

  async executeJob(jobId: string) {
    const job = this.dependencies.database.getJob(jobId);
    if (!job) {
      throw new Error('Scheduled job not found.');
    }

    job.status = 'running';
    job.updatedAt = nowIso();
    await this.dependencies.database.updateJob(job);
    this.dependencies.onSnapshot();

    const results: PlatformPublishResult[] = [];

    for (const platform of job.payload.selectedPlatforms) {
      const account = this.dependencies.database.getLatestConnectedAccount(platform);
      if (!account) {
        results.push({
          platform,
          status: 'failed',
          message: `No connected ${platformDefinitions[platform].displayName} account is available.`,
          publishedAt: null,
          postUrl: null,
        });
        continue;
      }

      const secret = this.dependencies.secureStore.getAccountSecret(account.id);
      if (!secret) {
        results.push({
          platform,
          status: 'failed',
          message: 'Local session could not be loaded.',
          publishedAt: null,
          postUrl: null,
        });
        continue;
      }

      const adapter = this.registry.get(platform);
      results.push(await adapter.publish({ account, secret, payload: job.payload }));
    }

    const finalStatus = deriveFinalStatus(results);
    const finishedAt = nowIso();
    const updatedJob: PublishJob = {
      ...job,
      status: finalStatus,
      updatedAt: finishedAt,
      finishedAt,
      results,
    };

    await this.dependencies.database.updateJob(updatedJob);
    this.dependencies.onSnapshot();
  }
}

function deriveFinalStatus(results: PlatformPublishResult[]): PublishJob['status'] {
  if (results.length === 0) {
    return 'failed';
  }

  const successCount = results.filter((result) => result.status === 'success').length;
  const failedCount = results.filter((result) => result.status === 'failed').length;

  if (successCount === results.length) {
    return 'completed';
  }

  if (failedCount === results.length) {
    return 'failed';
  }

  return 'partial';
}

export function buildAccountSecret(secret: AccountSecret) {
  return secret;
}
