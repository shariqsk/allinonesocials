import { clickFirst, fillFirst, setInputFilesFirst, waitForAnySelector } from './adapter-utils';
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
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
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
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });

      if (!(await this.isAuthenticated(context, page))) {
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
      return await this.withContext(options.secret.profileDir, async (_context, page) => {
        await page.goto('https://www.tiktok.com/upload?lang=en', {
          waitUntil: 'domcontentloaded',
        });

        await setInputFilesFirst(page, tiktokSelectors.fileInput, [video.path], 12_000);

        if (options.payload.body.trim()) {
          await fillFirst(page, tiktokSelectors.caption, options.payload.body, 8_000);
        }

        const createResponse = page
          .waitForResponse(
            (response) =>
              response.request().method() === 'POST' &&
              (response.url().includes('/api/upload/') ||
                response.url().includes('/api/post/item_create/') ||
                response.url().includes('/web/project/post/create/')),
            { timeout: 20_000 },
          )
          .catch(() => null);

        await clickFirst(page, tiktokSelectors.postButton, 10_000);

        const [response, successMarker] = await Promise.all([
          createResponse,
          waitForAnySelector(page, tiktokSelectors.successMarkers, 20_000),
        ]);

        if (response?.ok() || successMarker) {
          return this.buildSuccess(this.platform, 'Published on TikTok.', page.url());
        }

        if (response && !response.ok()) {
          return this.buildFailure(
            this.platform,
            `TikTok rejected the upload request with HTTP ${response.status()}.`,
          );
        }

        return this.buildFailure(
          this.platform,
          'TikTok did not confirm the upload after clicking Post.',
        );
      }, { headless: true });
    } catch (error) {
      return this.buildFailure(
        this.platform,
        error instanceof Error ? error.message : 'TikTok publishing failed.',
      );
    }
  }

  private async isAuthenticated(
    context: PublishOptions['secret'] extends never ? never : import('playwright').BrowserContext,
    page: import('playwright').Page,
  ) {
    const hasCookies = await this.hasCookies(context, ['sessionid'], [
      this.homeUrl,
      this.loginUrl,
    ]);

    if (hasCookies) {
      return true;
    }

    return this.hasVisibleMarker(page, tiktokSelectors.loggedInMarkers);
  }
}
