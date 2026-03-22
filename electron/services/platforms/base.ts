import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  onProgress?: (message: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  connect(options: ConnectOptions): Promise<SessionSummary>;
  validateSession(secret: AccountSecret): Promise<SessionSummary>;
  publish(options: PublishOptions): Promise<PlatformPublishResult>;
}

interface ContextOptions {
  headless?: boolean;
  background?: boolean;
  signal?: AbortSignal;
  userAgent?: string;
  extraHTTPHeaders?: Record<string, string>;
  ignoreDefaultArgs?: string[];
}

interface DebugCapture {
  diagnosticsDir: string;
  appendNote: (note: string) => void;
  persistFailureArtifacts: (page: Page, message: string) => Promise<string>;
  stop: () => Promise<void>;
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

  protected async withContext<T>(
    profileDir: string,
    fn: (context: BrowserContext, page: Page) => Promise<T>,
    options: ContextOptions = {},
  ) {
    await mkdir(profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: options.headless ?? false,
      viewport: { width: 1440, height: 960 },
      userAgent: options.userAgent,
      extraHTTPHeaders: options.extraHTTPHeaders,
      ignoreDefaultArgs: options.ignoreDefaultArgs,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        ...(options.background && !(options.headless ?? false)
          ? ['--window-position=-32000,-32000', '--window-size=1440,960', '--start-minimized']
          : []),
      ],
    });

    const page = context.pages()[0] ?? (await context.newPage());
    if (options.background && !(options.headless ?? false)) {
      await this.tryHidePageWindow(context, page);
    }
    const abortHandler = () => {
      void context.close().catch(() => null);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        abortHandler();
      } else {
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    try {
      return await fn(context, page);
    } finally {
      options.signal?.removeEventListener('abort', abortHandler);
      await context.close();
    }
  }

  protected async withOperationTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    message: string,
    signal?: AbortSignal,
  ) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(message));
      }, timeoutMs);
      const abortHandler = () => {
        cleanup();
        reject(new Error('Publishing was cancelled by user.'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
      };

      if (signal?.aborted) {
        cleanup();
        reject(new Error('Publishing was cancelled by user.'));
        return;
      }

      signal?.addEventListener('abort', abortHandler, { once: true });

      void operation()
        .then((result) => {
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
  }

  protected async tryHidePageWindow(context: BrowserContext, page: Page) {
    try {
      const session = await context.newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
    } catch {
      // Best effort only. Some Chromium builds/platforms may ignore these commands.
    }
  }

  protected async startDebugCapture(
    context: BrowserContext,
    page: Page,
    profileDir: string,
    platform: PlatformId,
  ): Promise<DebugCapture> {
    const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
    const diagnosticsDir = path.join(profileDir, 'debug-runs', `${platform}-${startedAt}`);
    const notes: string[] = [];
    const consoleEvents: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];

    await mkdir(diagnosticsDir, { recursive: true });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    const onConsole = (message: import('playwright').ConsoleMessage) => {
      consoleEvents.push(`[${message.type()}] ${message.text()}`);
    };
    const onPageError = (error: Error) => {
      pageErrors.push(error.stack ?? error.message);
    };
    const onRequestFailed = (request: import('playwright').Request) => {
      requestFailures.push(
        `${request.method()} ${request.url()}${request.failure() ? ` :: ${request.failure()?.errorText}` : ''}`,
      );
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    context.on('requestfailed', onRequestFailed);

    return {
      diagnosticsDir,
      appendNote: (note: string) => {
        notes.push(note);
      },
      persistFailureArtifacts: async (page, message) => {
        const screenshotPath = path.join(diagnosticsDir, 'failure.png');
        const htmlPath = path.join(diagnosticsDir, 'page.html');
        const tracePath = path.join(diagnosticsDir, 'trace.zip');
        const reportPath = path.join(diagnosticsDir, 'report.txt');

        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
        await writeFile(htmlPath, await page.content().catch(() => '<html></html>'), 'utf8');
        await context.tracing.stop({ path: tracePath }).catch(() => null);

        const report = [
          `Platform: ${platform}`,
          `Message: ${message}`,
          `URL: ${page.url()}`,
          '',
          'Notes:',
          ...(notes.length > 0 ? notes : ['(none)']),
          '',
          'Console:',
          ...(consoleEvents.length > 0 ? consoleEvents : ['(none)']),
          '',
          'Page errors:',
          ...(pageErrors.length > 0 ? pageErrors : ['(none)']),
          '',
          'Request failures:',
          ...(requestFailures.length > 0 ? requestFailures : ['(none)']),
        ].join('\n');

        await writeFile(reportPath, report, 'utf8');

        page.off('console', onConsole);
        page.off('pageerror', onPageError);
        context.off('requestfailed', onRequestFailed);

        return diagnosticsDir;
      },
      stop: async () => {
        page.off('console', onConsole);
        page.off('pageerror', onPageError);
        context.off('requestfailed', onRequestFailed);
        await context.tracing.stop().catch(() => null);
      },
    };
  }

  protected async buildFailureWithArtifacts(
    platform: PlatformId,
    message: string,
    page: Page,
    capture: DebugCapture,
  ) {
    const diagnosticsDir = await capture.persistFailureArtifacts(page, message);
    return this.buildFailure(platform, `${message} Diagnostics: ${diagnosticsDir}`);
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
