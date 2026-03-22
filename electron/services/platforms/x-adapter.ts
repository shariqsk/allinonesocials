import {
  clickFirstReady,
  clickNamedButton,
  fillFirst,
  setInputFilesFirst,
  tryClickFirst,
} from './adapter-utils';
import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

const xSelectors = {
  openComposer: [
    'a[data-testid="SideNav_NewTweet_Button"]',
    'button[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="SideNav_NewTweet_Button"]',
    'a[href="/compose/post"]',
  ],
  composer: ['div[role="textbox"][data-testid="tweetTextarea_0"]', 'div[role="textbox"]'],
  fileInput: ['input[data-testid="fileInput"]', 'input[type="file"]'],
  mediaPreview: [
    '[data-testid="attachments"]',
    '[data-testid="tweetPhoto"]',
    '[data-testid="videoPlayer"]',
    'video',
  ],
  postButton: [
    'button[data-testid="tweetButton"]',
    '[data-testid="tweetButton"]',
    'button[data-testid="tweetButtonInline"]',
    'div[data-testid="tweetButtonInline"]',
    'button[aria-label="Post"]',
    'button:has-text("Post")',
    'button:has-text("Tweet")',
  ],
  errorBanner: [
    'text="Something went wrong, but don’t fret — let’s give it another shot."',
    'text="Something went wrong"',
  ],
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
      return await this.withContext(options.secret.profileDir, async (context, page) => {
        const capture = await this.startDebugCapture(context, page, options.secret.profileDir, this.platform);
        const fail = (message: string) => this.buildFailureWithArtifacts(this.platform, message, page, capture);

        const result = await this.withOperationTimeout(async () => {
          await options.onProgress?.('Opening X composer');
          capture.appendNote('Navigating to X compose page');
          await page.goto('https://x.com/compose/post', {
            waitUntil: 'domcontentloaded',
            timeout: 15_000,
          });

          if (!(await this.isAuthenticated(context, page))) {
            return fail(
              'Login expired or X blocked the saved session. Reconnect before publishing.',
            );
          }

          const composerReady = await waitForAnyXSelector(page, xSelectors.composer, 6_000);
          const openedComposer =
            composerReady ??
            (await tryClickFirst(page, xSelectors.openComposer, 6_000)) ??
            (await clickNamedButton(page, ['Post', 'Tweet'], 6_000).catch(() => null));

          if (!openedComposer) {
            return fail(
              'Could not open the X post composer.',
            );
          }
          capture.appendNote(`Composer entry confirmed through: ${openedComposer}`);

          await options.onProgress?.('Filling the X post composer');
          await fillFirst(page, xSelectors.composer, options.payload.body);

          if (options.payload.assets.length > 0) {
            await options.onProgress?.('Uploading media to X');
            await setInputFilesFirst(
              page,
              xSelectors.fileInput,
              options.payload.assets.map((asset) => asset.path),
            );
            const previewSelector = await waitForAnyXSelector(page, xSelectors.mediaPreview, 20_000);
            capture.appendNote(`Media preview selector: ${previewSelector ?? 'not found'}`);
          }

          await options.onProgress?.('Submitting the X post');
          const clickedBySelector = await clickFirstReady(page, xSelectors.postButton, 15_000).catch(() => null);
          if (!clickedBySelector) {
            const clickedByName = await clickNamedButton(page, ['Post', 'Tweet'], 15_000);
            capture.appendNote(`Submit clicked by name: ${clickedByName}`);
          } else {
            capture.appendNote(`Submit clicked by selector: ${clickedBySelector}`);
          }

          await options.onProgress?.('Waiting for X to confirm the post (up to 15s)');
          let confirmation = await waitForXCreateResponse(page, 15_000);
          if (!confirmation) {
            await options.onProgress?.('Retrying X submit shortcut');
            await page.keyboard.press('Meta+Enter').catch(() => null);
            confirmation = await waitForXCreateResponse(page, 12_000);
            capture.appendNote('Triggered Meta+Enter retry for X submit');
          }

          const submitError = await waitForAnyXSelector(page, xSelectors.errorBanner, 3_000);
          if (submitError) {
            return fail(
              'X showed an in-app error after submit: Something went wrong, but don’t fret — let’s give it another shot.',
            );
          }

          if (!confirmation) {
            return fail(
              'X did not confirm the post after the click and retry shortcut.',
            );
          }

          if (isPlaywrightResponse(confirmation) && !confirmation.ok()) {
            return fail(
              `X rejected the publish request with HTTP ${confirmation.status()}.`,
            );
          }

          if (isPlaywrightResponse(confirmation)) {
            const submissionError = await readXSubmissionError(confirmation);
            if (submissionError) {
              return fail(submissionError);
            }
          }

          const composerClosed = await waitForXComposerToClose(page, 8_000);
          capture.appendNote(`Composer closed after submit: ${composerClosed}`);
          if (!composerClosed) {
            return fail(
              'X returned a publish response, but the composer stayed open and the post was not confirmed in the UI.',
            );
          }

          return this.buildSuccess(this.platform, 'Published on X.', page.url());
        }, 55_000, 'X publish timed out before the site confirmed the post.', options.signal)
          .catch((error) => fail(error instanceof Error ? error.message : 'X publishing failed.'));

        await capture.stop();
        return result;
      }, { headless: false, background: true, signal: options.signal });
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

async function waitForAnyXSelector(
  page: import('playwright').Page,
  selectors: string[],
  timeout: number,
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if ((await locator.count()) > 0 && (await locator.isVisible())) {
          return selector;
        }
      } catch {
        continue;
      }
    }

    await page.waitForTimeout(400);
  }

  return null;
}

async function waitForXComposerToClose(
  page: import('playwright').Page,
  timeout: number,
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const composerVisible = await waitForAnyXSelector(page, xSelectors.composer, 400);
    if (!composerVisible && !page.url().includes('/compose/post')) {
      return true;
    }

    await page.waitForTimeout(300);
  }

  return false;
}

function isPlaywrightResponse(
  value: Awaited<ReturnType<typeof waitForXCreateResponse>>,
): value is import('playwright').Response {
  return (
    value !== null &&
    typeof value.ok === 'function' &&
    typeof value.status === 'function'
  );
}

async function waitForXCreateResponse(page: import('playwright').Page, timeout: number) {
  return page
    .waitForResponse(
      (nextResponse) =>
        nextResponse.request().method() === 'POST' && isXCreatePostUrl(nextResponse.url()),
      { timeout },
    )
    .catch(() => null);
}

function isXCreatePostUrl(url: string) {
  return (
    url.includes('/CreateTweet') ||
    url.includes('/CreatePost') ||
    url.includes('/TweetCreate') ||
    url.includes('/graphql/') && (url.includes('CreateTweet') || url.includes('CreatePost'))
  );
}

async function readXSubmissionError(response: import('playwright').Response) {
  try {
    const payload = await response.json();
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    if (errors.length === 0) {
      if (payload?.data && Object.keys(payload.data).length > 0) {
        return null;
      }

      return 'X returned an empty publish response, and the post was not confirmed.';
    }

    const firstError = errors[0] as {
      code?: number;
      message?: string;
      extensions?: { code?: number };
    };
    const code = firstError.code ?? firstError.extensions?.code;
    const message = typeof firstError.message === 'string' ? firstError.message : 'Unknown X publish error.';

    if (code === 226) {
      return `X blocked this publish as automated (code 226). The saved X session needs a less detectable browser mode or a manual retry in X.`;
    }

    return `X rejected the publish request: ${message}${code ? ` (code ${code})` : ''}`;
  } catch {
    return null;
  }
}
