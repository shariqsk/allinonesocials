import { clickFirst, fillFirst, setInputFilesFirst } from './adapter-utils';
import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

const instagramSelectors = {
  loggedInMarkers: [
    'a[href="/create/select/"]',
    '[aria-label="New post"]',
    'a[href="/direct/inbox/"]',
    'svg[aria-label="Home"]',
  ],
  createButton: ['a[href="/create/select/"]', '[aria-label="New post"]'],
  fileInput: ['input[type="file"]'],
  nextButton: ['text=Next'],
  caption: ['textarea[aria-label="Write a caption..."]', 'textarea'],
  shareButton: ['text=Share'],
};

export class InstagramAdapter extends BaseAdapter {
  readonly platform = 'instagram' as const;

  protected readonly loginUrl = 'https://www.instagram.com/accounts/login/';

  protected readonly homeUrl = 'https://www.instagram.com/';

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
          'Instagram account',
          'Instagram sign-in was not completed. Finish login and any checkpoints in the opened browser window, then reconnect.',
          page.url(),
        );
      }

      return this.buildConnectedSummary(
        'Instagram account',
        'Connected through a saved Instagram browser session.',
        page.url(),
      );
    });
  }

  async validateSession(secret: PublishOptions['secret']): Promise<SessionSummary> {
    return this.withContext(secret.profileDir, async (context, page) => {
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });

      if (!(await this.isAuthenticated(context, page))) {
        return this.buildAttentionSummary(
          'Instagram account',
          'Login expired or Instagram still needs a manual checkpoint.',
          page.url(),
        );
      }

      return this.buildConnectedSummary(
        'Instagram account',
        'Session is ready for publishing.',
        page.url(),
      );
    });
  }

  async publish(options: PublishOptions) {
    if (options.payload.assets.length === 0) {
      return this.buildFailure(this.platform, 'Instagram publishing requires at least one image.');
    }

    try {
      return await this.withContext(options.secret.profileDir, async (_context, page) => {
        await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
        await clickFirst(page, instagramSelectors.createButton, 4000);
        await setInputFilesFirst(
          page,
          instagramSelectors.fileInput,
          options.payload.assets.map((asset) => asset.path),
          4000,
        );
        await clickFirst(page, instagramSelectors.nextButton, 4000);
        await clickFirst(page, instagramSelectors.nextButton, 4000);
        await fillFirst(page, instagramSelectors.caption, options.payload.body, 4000);
        await clickFirst(page, instagramSelectors.shareButton, 4000);
        await page.waitForTimeout(2500);

        return this.buildSuccess(this.platform, 'Published on Instagram.', page.url());
      });
    } catch (error) {
      return this.buildFailure(
        this.platform,
        error instanceof Error ? error.message : 'Instagram publishing failed.',
      );
    }
  }

  private async isAuthenticated(context: PublishOptions['secret'] extends never ? never : import('playwright').BrowserContext, page: import('playwright').Page) {
    const hasCookies = await this.hasCookies(context, ['sessionid', 'ds_user_id'], [
      this.homeUrl,
      this.loginUrl,
    ]);

    if (hasCookies) {
      return true;
    }

    return this.hasVisibleMarker(page, instagramSelectors.loggedInMarkers);
  }
}
