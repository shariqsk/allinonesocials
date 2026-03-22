import { clickFirst, fillFirst, setInputFilesFirst } from './adapter-utils';
import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

const xSelectors = {
  composer: ['div[role="textbox"][data-testid="tweetTextarea_0"]', 'div[role="textbox"]'],
  fileInput: ['input[data-testid="fileInput"]', 'input[type="file"]'],
  postButton: ['button[data-testid="tweetButton"]', 'div[data-testid="tweetButtonInline"]'],
  loggedInMarkers: [
    'a[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="AppTabBar_Home_Link"]',
    '[data-testid="SideNav_AccountSwitcher_Button"]',
    'button[aria-label="Account menu"]',
  ],
};

export class XAdapter extends BaseAdapter {
  readonly platform = 'x' as const;

  protected readonly loginUrl = 'https://x.com/home';

  protected readonly homeUrl = 'https://x.com/home';

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
          'X account',
          'X sign-in was not completed. Finish login in the opened browser window, then reconnect.',
          page.url(),
        );
      }

      return this.buildConnectedSummary(
        'X account',
        'Connected through a saved X browser session.',
        page.url(),
      );
    });
  }

  async validateSession(secret: PublishOptions['secret']): Promise<SessionSummary> {
    return this.withContext(secret.profileDir, async (context, page) => {
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });

      if (!(await this.isAuthenticated(context, page))) {
        return this.buildAttentionSummary(
          'X account',
          'Login expired or X blocked the session. Reconnect before publishing.',
          page.url(),
        );
      }

      return this.buildConnectedSummary('X account', 'Session is ready for publishing.', page.url());
    }, { headless: true });
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
          await page.waitForTimeout(250);
        }

        const createPostResponse = page
          .waitForResponse(
            (response) =>
              response.request().method() === 'POST' && isXCreatePostUrl(response.url()),
            { timeout: 12_000 },
          )
          .catch(() => null);

        await clickFirst(page, xSelectors.postButton);

        const response = await createPostResponse;
        if (!response) {
          return this.buildFailure(
            this.platform,
            'X did not confirm post creation after the publish click. Nothing was marked as posted.',
          );
        }

        if (!response.ok()) {
          return this.buildFailure(
            this.platform,
            `X rejected the publish request with HTTP ${response.status()}.`,
          );
        }

        return this.buildSuccess(this.platform, 'Published on X.', page.url());
      }, { headless: true });
    } catch (error) {
      return this.buildFailure(
        this.platform,
        error instanceof Error ? error.message : 'X publishing failed.',
      );
    }
  }

  private async isAuthenticated(context: PublishOptions['secret'] extends never ? never : import('playwright').BrowserContext, page: import('playwright').Page) {
    const hasCookies = await this.hasCookies(context, ['auth_token', 'ct0'], [
      this.homeUrl,
      'https://x.com/',
    ]);

    if (hasCookies) {
      return true;
    }

    return this.hasVisibleMarker(page, xSelectors.loggedInMarkers);
  }
}

function isXCreatePostUrl(url: string) {
  return (
    url.includes('/CreateTweet') ||
    url.includes('/CreatePost') ||
    url.includes('/TweetCreate') ||
    url.includes('/graphql/') && (url.includes('CreateTweet') || url.includes('CreatePost'))
  );
}
