import {
  clickFirstReady,
  clickNamedButton,
  fillFirst,
  setInputFilesFirst,
  waitForAnySelector,
} from './adapter-utils';
import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

const tiktokSelectors = {
  loggedInMarkers: [
    'a[href*="/upload"]',
    '[data-e2e="nav-upload"]',
    '[data-e2e="top-avatar"]',
    'button[aria-label*="profile"]',
  ],
  fileInput: [
    'input[type="file"]',
    'input[accept*="video"]',
  ],
  caption: [
    'div[contenteditable="true"]',
    'textarea',
  ],
  postButton: [
    'button:has-text("Post")',
    'button[data-e2e="post_video_button"]',
    'button:has-text("Publish")',
    'button[data-e2e*="post"]',
    'button[aria-label*="Post"]',
    '[role="button"]:has-text("Post")',
    '[role="button"]:has-text("Publish")',
  ],
  blockingModalButtons: [
    'button:has-text("Turn on")',
    'button:has-text("Cancel")',
    'button:has-text("Got it")',
    '[role="button"]:has-text("Turn on")',
    '[role="button"]:has-text("Cancel")',
    '[role="button"]:has-text("Got it")',
  ],
  successMarkers: [
    'text=Uploaded',
    'text=Your video is being uploaded',
    'text=Video uploaded',
    'text=Manage posts',
  ],
};

export class TikTokAdapter extends BaseAdapter {
  readonly platform = 'tiktok' as const;

  protected readonly loginUrl = 'https://www.tiktok.com/login';

  protected readonly homeUrl = 'https://www.tiktok.com/';

  async connect(options: ConnectOptions): Promise<SessionSummary> {
    return this.withContext(options.profileDir, async (context, page) => {
      await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();

      const authenticated = await this.waitForAuthenticatedSession(
        context,
        page,
        () => this.isAuthenticated(context, page),
      );

      if (!authenticated) {
        return this.buildAttentionSummary(
          'TikTok account',
          'TikTok sign-in was not completed. Finish login in the opened browser window, then reconnect.',
          page.url(),
        );
      }

      return this.buildConnectedSummary(
        'TikTok account',
        'Connected through a saved TikTok browser session.',
        page.url(),
      );
    });
  }

  async validateSession(secret: PublishOptions['secret']): Promise<SessionSummary> {
    return this.withContext(secret.profileDir, async (context, page) => {
      if (!(await this.hasSessionCookies(context))) {
        return this.buildAttentionSummary(
          'TikTok account',
          'Login expired or TikTok needs another checkpoint before publishing.',
          page.url(),
        );
      }

      return this.buildConnectedSummary(
        'TikTok account',
        'Session is ready for TikTok web upload.',
        page.url(),
      );
    }, { headless: true });
  }

  async publish(options: PublishOptions) {
    const video = options.payload.assets.find((asset) => asset.mediaKind === 'video');
    if (!video) {
      return this.buildFailure(this.platform, 'TikTok publishing requires exactly one video.');
    }

    try {
      return await this.withContext(options.secret.profileDir, async (context, page) => {
        const capture = await this.startDebugCapture(context, page, options.secret.profileDir, this.platform);
        const fail = (message: string) => this.buildFailureWithArtifacts(this.platform, message, page, capture);

        const result = await this.withOperationTimeout(async () => {
          if (!(await this.hasSessionCookies(context))) {
            return fail(
              'Login expired or TikTok needs another checkpoint before publishing.',
            );
          }

          await options.onProgress?.('Opening the TikTok upload workspace');
          capture.appendNote('Navigating to TikTok upload workspace');
          await page.goto('https://www.tiktok.com/upload?lang=en', {
            waitUntil: 'domcontentloaded',
          });

          await options.onProgress?.('Uploading the TikTok video');
          await setInputFilesFirst(page, tiktokSelectors.fileInput, [video.path], 12_000);
          capture.appendNote(`TikTok video queued: ${video.path}`);

          if (options.payload.body.trim()) {
            await options.onProgress?.('Adding the TikTok caption');
            await fillFirst(page, tiktokSelectors.caption, options.payload.body, 8_000);
          }

          await dismissTikTokBlockingModals(page, capture);

          await options.onProgress?.('Waiting for TikTok to process the video (up to 45s)');
          const createResponse = page
            .waitForResponse(
              (response) =>
                response.request().method() === 'POST' &&
                (response.url().includes('/api/upload/') ||
                  response.url().includes('/api/post/item_create/') ||
                  response.url().includes('/web/project/post/create/')),
              { timeout: 45_000 },
            )
            .catch(() => null);

          const clickedByName = await clickNamedButton(page, ['Post', 'Publish'], 45_000).catch(() => null);
          if (!clickedByName) {
            await clickFirstReady(page, tiktokSelectors.postButton, 45_000);
            capture.appendNote('TikTok submit clicked by selector fallback');
          } else {
            capture.appendNote(`TikTok submit clicked by name: ${clickedByName}`);
          }

          await options.onProgress?.('Waiting for TikTok to confirm the upload (up to 45s)');
          const [response, successMarker] = await Promise.all([
          createResponse,
            waitForAnySelector(page, tiktokSelectors.successMarkers, 20_000),
          ]);

          if (response?.ok() || successMarker) {
            return this.buildSuccess(this.platform, 'Published on TikTok.', page.url());
          }

          if (response && !response.ok()) {
            return fail(
              `TikTok rejected the upload request with HTTP ${response.status()}.`,
            );
          }

          return fail(
            'TikTok did not confirm the upload within 45 seconds after clicking Post.',
          );
        }, 70_000, 'TikTok publish timed out before the upload was confirmed.', options.signal)
          .catch((error) => fail(error instanceof Error ? error.message : 'TikTok publishing failed.'));

        await capture.stop();
        return result;
      }, { headless: true, signal: options.signal });
    } catch (error) {
        return this.buildFailure(
          this.platform,
          error instanceof Error ? error.message : 'TikTok publishing failed.',
        );
    }
  }

  private async isAuthenticated(
    context: PublishOptions['secret'] extends never ? never : import('playwright').BrowserContext,
    _page: import('playwright').Page,
  ) {
    return this.hasSessionCookies(context);
  }

  private async hasSessionCookies(
    context: PublishOptions['secret'] extends never ? never : import('playwright').BrowserContext,
  ) {
    const cookies = await context.cookies([this.homeUrl, this.loginUrl]);
    return cookies.some(
      (cookie) =>
        ['sessionid', 'sessionid_ss', 'sid_guard'].includes(cookie.name) &&
        Boolean(cookie.value),
    );
  }
}

async function dismissTikTokBlockingModals(
  page: import('playwright').Page,
  capture: { appendNote: (note: string) => void },
) {
  const clickedByName = await clickNamedButton(page, ['Turn on', 'Cancel', 'Got it'], 3000).catch(() => null);
  if (clickedByName) {
    capture.appendNote(`Dismissed TikTok blocking modal with: ${clickedByName}`);
  }

  await clickFirstReady(page, tiktokSelectors.blockingModalButtons, 1500).catch(() => null);
}
