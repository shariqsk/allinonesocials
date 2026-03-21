import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type {
  ComposerInput,
  PlatformAccount,
  PlatformId,
  PlatformPublishResult,
} from '../../../src/shared/types';
import type { AccountSecret } from '../secure-store';

export interface SessionSummary {
  label: string;
  detail: string;
  status: PlatformAccount['status'];
  lastKnownUrl: string | null;
}

export interface ConnectOptions {
  accountId: string;
  profileDir: string;
}

export interface PublishOptions {
  account: PlatformAccount;
  secret: AccountSecret;
  payload: ComposerInput;
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  connect(options: ConnectOptions): Promise<SessionSummary>;
  validateSession(secret: AccountSecret): Promise<SessionSummary>;
  publish(options: PublishOptions): Promise<PlatformPublishResult>;
}

export abstract class BaseAdapter implements PlatformAdapter {
  abstract readonly platform: PlatformId;

  protected abstract readonly loginUrl: string;

  protected abstract readonly homeUrl: string;

  abstract connect(options: ConnectOptions): Promise<SessionSummary>;

  abstract validateSession(secret: AccountSecret): Promise<SessionSummary>;

  abstract publish(options: PublishOptions): Promise<PlatformPublishResult>;

  protected async waitForAuthenticatedSession(
    context: BrowserContext,
    page: Page,
    isAuthenticated: () => Promise<boolean>,
    timeoutMs = 300_000,
  ) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        break;
      }

      if (await isAuthenticated()) {
        return true;
      }

      await page.waitForTimeout(1000);
    }

    return false;
  }

  protected async hasCookies(context: BrowserContext, names: string[], urls: string[]) {
    const cookies = await context.cookies(urls);
    return names.every((name) => cookies.some((cookie) => cookie.name === name && Boolean(cookie.value)));
  }

  protected async hasVisibleMarker(page: Page, selectors: string[]) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        try {
          if (await locator.isVisible()) {
            return true;
          }
        } catch {
          continue;
        }
      }
    }

    return false;
  }

  protected async withContext<T>(profileDir: string, fn: (context: BrowserContext, page: Page) => Promise<T>) {
    await mkdir(profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1440, height: 960 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = context.pages()[0] ?? (await context.newPage());

    try {
      return await fn(context, page);
    } finally {
      await context.close();
    }
  }

  protected buildSuccess(platform: PlatformId, message: string, postUrl: string | null = null): PlatformPublishResult {
    return {
      platform,
      status: 'success',
      message,
      publishedAt: new Date().toISOString(),
      postUrl,
    };
  }

  protected buildFailure(platform: PlatformId, message: string): PlatformPublishResult {
    return {
      platform,
      status: 'failed',
      message,
      publishedAt: null,
      postUrl: null,
    };
  }

  protected buildConnectedSummary(label: string, detail: string, lastKnownUrl: string | null): SessionSummary {
    return {
      label,
      detail,
      status: 'connected',
      lastKnownUrl,
    };
  }

  protected buildAttentionSummary(label: string, detail: string, lastKnownUrl: string | null): SessionSummary {
    return {
      label,
      detail,
      status: 'attention',
      lastKnownUrl,
    };
  }
}
