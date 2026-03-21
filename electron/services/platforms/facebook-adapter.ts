import { clickFirst, fillFirst, setInputFilesFirst, waitForAnySelector } from './adapter-utils';
import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

const facebookSelectors = {
  loggedInMarkers: ['[aria-label="Create a post"]', '[role="feed"]'],
  openComposer: ['[aria-label="Create a post"]', 'div[role="button"][aria-label*="mind"]'],
  composer: ['div[role="textbox"]', '[contenteditable="true"]'],
  fileInput: ['input[type="file"]'],
  postButton: ['div[aria-label="Post"]', 'div[role="button"][aria-label="Post"]'],
};

export class FacebookAdapter extends BaseAdapter {
  readonly platform = 'facebook' as const;

  protected readonly loginUrl = 'https://www.facebook.com/login';

  protected readonly homeUrl = 'https://www.facebook.com/';

  async connect(options: ConnectOptions): Promise<SessionSummary> {
    return this.withContext(options.profileDir, async (_context, page) => {
      await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' });
      await waitForAnySelector(page, facebookSelectors.loggedInMarkers, 300000);

      return {
        label: 'Facebook account',
        detail: 'Connected through a saved browser session.',
        status: 'connected',
        lastKnownUrl: page.url(),
      };
    });
  }

  async validateSession(secret: PublishOptions['secret']): Promise<SessionSummary> {
    return this.withContext(secret.profileDir, async (_context, page) => {
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
      const marker = await waitForAnySelector(page, facebookSelectors.loggedInMarkers);

      if (!marker) {
        return {
          label: 'Facebook account',
          detail: 'Login expired or Facebook needs attention.',
          status: 'attention',
          lastKnownUrl: page.url(),
        };
      }

      return {
        label: 'Facebook account',
        detail: 'Session is ready for publishing.',
        status: 'connected',
        lastKnownUrl: page.url(),
      };
    });
  }

  async publish(options: PublishOptions) {
    try {
      return await this.withContext(options.secret.profileDir, async (_context, page) => {
        await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
        await clickFirst(page, facebookSelectors.openComposer, 4000);
        await fillFirst(page, facebookSelectors.composer, options.payload.body, 4000);

        if (options.payload.assets.length > 0) {
          await setInputFilesFirst(
            page,
            facebookSelectors.fileInput,
            options.payload.assets.map((asset) => asset.path),
          );
          await page.waitForTimeout(1500);
        }

        await clickFirst(page, facebookSelectors.postButton, 4000);
        await page.waitForTimeout(2500);

        return this.buildSuccess(this.platform, 'Published on Facebook.', page.url());
      });
    } catch (error) {
      return this.buildFailure(
        this.platform,
        error instanceof Error ? error.message : 'Facebook publishing failed.',
      );
    }
  }
}
