import { clickFirst, fillFirst, setInputFilesFirst, waitForAnySelector } from './adapter-utils';
import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

const xSelectors = {
  composer: ['div[role="textbox"][data-testid="tweetTextarea_0"]', 'div[role="textbox"]'],
  fileInput: ['input[data-testid="fileInput"]', 'input[type="file"]'],
  postButton: ['button[data-testid="tweetButton"]', 'div[data-testid="tweetButtonInline"]'],
  loggedInMarkers: ['a[data-testid="SideNav_NewTweet_Button"]', 'a[aria-label="Profile"]'],
};

export class XAdapter extends BaseAdapter {
  readonly platform = 'x' as const;

  protected readonly loginUrl = 'https://x.com/i/flow/login';

  protected readonly homeUrl = 'https://x.com/home';

  async connect(options: ConnectOptions): Promise<SessionSummary> {
    return this.withContext(options.profileDir, async (_context, page) => {
      await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' });
      await waitForAnySelector(page, xSelectors.loggedInMarkers, 300000);

      return {
        label: 'X account',
        detail: 'Connected through a saved browser session.',
        status: 'connected',
        lastKnownUrl: page.url(),
      };
    });
  }

  async validateSession(secret: PublishOptions['secret']): Promise<SessionSummary> {
    return this.withContext(secret.profileDir, async (_context, page) => {
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
      const marker = await waitForAnySelector(page, xSelectors.loggedInMarkers);

      if (!marker) {
        return {
          label: 'X account',
          detail: 'Login expired. Reconnect this account before publishing.',
          status: 'attention',
          lastKnownUrl: page.url(),
        };
      }

      return {
        label: 'X account',
        detail: 'Session is ready for publishing.',
        status: 'connected',
        lastKnownUrl: page.url(),
      };
    });
  }

  async publish(options: PublishOptions) {
    try {
      return await this.withContext(options.secret.profileDir, async (_context, page) => {
        await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });
        await fillFirst(page, xSelectors.composer, options.payload.body);

        if (options.payload.assets.length > 0) {
          await setInputFilesFirst(
            page,
            xSelectors.fileInput,
            options.payload.assets.map((asset) => asset.path),
          );
          await page.waitForTimeout(1000);
        }

        await clickFirst(page, xSelectors.postButton);
        await page.waitForTimeout(2000);

        return this.buildSuccess(this.platform, 'Published on X.', page.url());
      });
    } catch (error) {
      return this.buildFailure(
        this.platform,
        error instanceof Error ? error.message : 'X publishing failed.',
      );
    }
  }
}
