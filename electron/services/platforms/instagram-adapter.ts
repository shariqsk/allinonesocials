import { clickFirst, fillFirst, setInputFilesFirst, waitForAnySelector } from './adapter-utils';
import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

const instagramSelectors = {
  loggedInMarkers: ['a[href="/create/select/"]', 'svg[aria-label="New post"]'],
  createButton: ['a[href="/create/select/"]', 'svg[aria-label="New post"]'],
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
    return this.withContext(options.profileDir, async (_context, page) => {
      await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' });
      await waitForAnySelector(page, instagramSelectors.loggedInMarkers, 300000);

      return {
        label: 'Instagram account',
        detail: 'Connected through a saved browser session.',
        status: 'connected',
        lastKnownUrl: page.url(),
      };
    });
  }

  async validateSession(secret: PublishOptions['secret']): Promise<SessionSummary> {
    return this.withContext(secret.profileDir, async (_context, page) => {
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
      const marker = await waitForAnySelector(page, instagramSelectors.loggedInMarkers);

      if (!marker) {
        return {
          label: 'Instagram account',
          detail: 'Login expired or Instagram needs a manual checkpoint.',
          status: 'attention',
          lastKnownUrl: page.url(),
        };
      }

      return {
        label: 'Instagram account',
        detail: 'Session is ready for publishing.',
        status: 'connected',
        lastKnownUrl: page.url(),
      };
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
}
