import { clickFirst, fillFirst, setInputFilesFirst } from './adapter-utils';
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
          'Facebook account',
          'Facebook sign-in was not completed. Finish login in the opened browser window, then reconnect.',
          page.url(),
        );
      }

      return this.buildConnectedSummary(
        'Facebook account',
        'Connected through a saved Facebook browser session.',
        page.url(),
      );
    });
  }

  async validateSession(secret: PublishOptions['secret']): Promise<SessionSummary> {
    return this.withContext(secret.profileDir, async (context, page) => {
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });

      if (!(await this.isAuthenticated(context, page))) {
        return this.buildAttentionSummary(
          'Facebook account',
          'Login expired or Facebook needs attention before publishing.',
          page.url(),
        );
      }

      return this.buildConnectedSummary(
        'Facebook account',
        'Session is ready for publishing.',
        page.url(),
      );
    }, { headless: true });
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
          await page.waitForTimeout(400);
        }

        await clickFirst(page, facebookSelectors.postButton, 4000);
        await page.waitForTimeout(800);

        return this.buildSuccess(this.platform, 'Published on Facebook.', page.url());
      }, { headless: true });
    } catch (error) {
      return this.buildFailure(
        this.platform,
        error instanceof Error ? error.message : 'Facebook publishing failed.',
      );
    }
  }

  private async isAuthenticated(context: PublishOptions['secret'] extends never ? never : import('playwright').BrowserContext, page: import('playwright').Page) {
    const hasCookies = await this.hasCookies(context, ['c_user', 'xs'], [
      this.homeUrl,
      this.loginUrl,
    ]);

    if (hasCookies) {
      return true;
    }

    return this.hasVisibleMarker(page, facebookSelectors.loggedInMarkers);
  }
}
