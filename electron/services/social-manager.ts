import { rm } from 'node:fs/promises';
import path from 'node:path';
import dayjs from 'dayjs';
import { platformDefinitions, validateComposer, normalizeComposerInput } from '../../src/shared/content';
import type {
  CancelJobInput,
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
  private readonly runningControllers = new Map<string, AbortController>();

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

  async validateAllAccounts() {
    const accounts = this.dependencies.database.listAccounts();

    for (const account of accounts) {
      const secret = this.dependencies.secureStore.getAccountSecret(account.id);
      if (!secret) {
        const updated: PlatformAccount = {
          ...account,
          status: 'attention',
          detail: 'Local session data is missing. Reconnect this account.',
          updatedAt: nowIso(),
          lastValidatedAt: nowIso(),
        };
        await this.dependencies.database.upsertAccount(updated);
        continue;
      }

      try {
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
      } catch {
        const updated: PlatformAccount = {
          ...account,
          status: 'attention',
          detail: 'This saved session could not be validated. Reconnect this account.',
          updatedAt: nowIso(),
          lastValidatedAt: nowIso(),
        };
        await this.dependencies.database.upsertAccount(updated);
      }
    }

    this.dependencies.onSnapshot();
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

  async clearHistory() {
    await this.dependencies.database.clearHistory();
    this.dependencies.onSnapshot();
  }

  async cancelJob(input: CancelJobInput) {
    const job = this.dependencies.database.getJob(input.jobId);
    if (!job) {
      throw new Error('Job not found.');
    }

    if (job.status === 'pending') {
      const cancelledAt = nowIso();
      const updatedJob: PublishJob = {
        ...job,
        status: 'cancelled',
        updatedAt: cancelledAt,
        finishedAt: cancelledAt,
        results: job.payload.selectedPlatforms.map((platform) => buildCancelledResult(platform)),
      };
      await this.dependencies.database.updateJob(updatedJob);
      this.dependencies.onSnapshot();
      return;
    }

    const controller = this.runningControllers.get(input.jobId);
    if (!controller) {
      throw new Error('This job is not currently running.');
    }

    controller.abort();
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
    const controller = new AbortController();
    this.runningControllers.set(jobId, controller);

    const orderedResults: Array<PlatformPublishResult | undefined> = new Array(
      job.payload.selectedPlatforms.length,
    );
    let updateQueue = Promise.resolve();
    const queueProgressUpdate = () => {
      updateQueue = updateQueue.then(async () => {
        const runningJob: PublishJob = {
          ...job,
          status: 'running',
          updatedAt: nowIso(),
          results: orderedResults.filter(Boolean) as PlatformPublishResult[],
        };
        await this.dependencies.database.updateJob(runningJob);
        this.dependencies.onSnapshot();
      });
      return updateQueue;
    };

    try {
      const results = await Promise.all(
        job.payload.selectedPlatforms.map(async (platform, index) => {
        const account = this.dependencies.database.getLatestConnectedAccount(platform);
        if (!account) {
          const result = {
            platform,
            status: 'failed' as const,
            message: `No connected ${platformDefinitions[platform].displayName} account is available.`,
            publishedAt: null,
            postUrl: null,
          };
          orderedResults[index] = result;
          await queueProgressUpdate();
          return result;
        }

        const secret = this.dependencies.secureStore.getAccountSecret(account.id);
        if (!secret) {
          const result = {
            platform,
            status: 'failed' as const,
            message: 'Local session could not be loaded.',
            publishedAt: null,
            postUrl: null,
          };
          orderedResults[index] = result;
          await queueProgressUpdate();
          return result;
        }

        const adapter = this.registry.get(platform);
        orderedResults[index] = buildRunningResult(platform, 'Opening saved session…');
        await queueProgressUpdate();

        if (controller.signal.aborted) {
          const cancelled = buildCancelledResult(platform);
          orderedResults[index] = cancelled;
          await queueProgressUpdate();
          return cancelled;
        }

        let result: PlatformPublishResult;
        try {
          result = await adapter.publish({
            account,
            secret,
            payload: job.payload,
            signal: controller.signal,
            onProgress: async (message) => {
              if (controller.signal.aborted) {
                return;
              }
              orderedResults[index] = buildRunningResult(platform, message);
              await queueProgressUpdate();
            },
          });
        } catch {
          result = controller.signal.aborted
            ? buildCancelledResult(platform)
            : {
                platform,
                status: 'failed',
                message: 'Publishing failed unexpectedly.',
                publishedAt: null,
                postUrl: null,
              };
        }

        if (controller.signal.aborted) {
          result = buildCancelledResult(platform);
        }

        if (result.status === 'failed' && shouldMarkAccountAttention(result.message)) {
          const updatedAccount: PlatformAccount = {
            ...account,
            status: 'attention',
            detail: result.message,
            updatedAt: nowIso(),
            lastValidatedAt: nowIso(),
          };
          await this.dependencies.database.upsertAccount(updatedAccount);
        }

        orderedResults[index] = result;
        await queueProgressUpdate();
        return result;
        }),
      );
      await updateQueue;

      const finalStatus = controller.signal.aborted ? 'cancelled' : deriveFinalStatus(results);
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
    } finally {
      this.runningControllers.delete(jobId);
    }
  }
}

function buildRunningResult(platform: PlatformPublishResult['platform'], message: string): PlatformPublishResult {
  return {
    platform,
    status: 'running',
    message,
    publishedAt: null,
    postUrl: null,
  };
}

function buildCancelledResult(platform: PlatformPublishResult['platform']): PlatformPublishResult {
  return {
    platform,
    status: 'skipped',
    message: 'Publishing was cancelled by user.',
    publishedAt: null,
    postUrl: null,
  };
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

function shouldMarkAccountAttention(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('login expired') ||
    normalized.includes('sign-in') ||
    normalized.includes('reconnect') ||
    normalized.includes('checkpoint') ||
    normalized.includes('not authenticated') ||
    normalized.includes('session')
  );
}

export function buildAccountSecret(secret: AccountSecret) {
  return secret;
}
