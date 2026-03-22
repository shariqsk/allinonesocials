import {
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

const xChromeUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

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
          await prepareXHeadlessSession(context);
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
            (await tryClickFirst(page, xSelectors.openComposer, 6_000));

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
          const submitSelector = await waitForReadyXSubmitButton(
            page,
            options.payload.assets.length > 0 ? 45_000 : 20_000,
          );
          capture.appendNote(`Submit button ready through: ${submitSelector ?? 'not found'}`);
          if (!submitSelector) {
            return fail(
              'X never enabled the Post button. The draft was filled, but X kept the publish control disabled.',
            );
          }
          await page.locator(submitSelector).first().click({ timeout: 2_000 });
          capture.appendNote(`Submit clicked by selector: ${submitSelector}`);

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
            const submission = await readXSubmissionResult(confirmation);
            if (submission.error) {
              return fail(submission.error);
            }

            capture.appendNote(`X submission accepted with tweet id: ${submission.tweetId ?? 'unknown'}`);
          }

          const submitErrorAfterResponse = await waitForAnyXSelector(page, xSelectors.errorBanner, 1_500);
          if (submitErrorAfterResponse) {
            return fail(
              'X showed an in-app error after the publish response, and the post was not confirmed.',
            );
          }

          return this.buildSuccess(this.platform, 'Published on X.', page.url());
        }, 55_000, 'X publish timed out before the site confirmed the post.', options.signal)
          .catch((error) => fail(error instanceof Error ? error.message : 'X publishing failed.'));

        await capture.stop();
        return result;
      }, {
        headless: true,
        signal: options.signal,
        userAgent: xChromeUserAgent,
        extraHTTPHeaders: {
          'sec-ch-ua': '"Google Chrome";v="145", "Chromium";v="145", "Not=A?Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
        },
        ignoreDefaultArgs: ['--enable-automation'],
      });
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

async function waitForReadyXSubmitButton(
  page: import('playwright').Page,
  timeout: number,
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of xSelectors.postButton) {
      const locator = page.locator(selector).first();
      try {
        if ((await locator.count()) === 0 || !(await locator.isVisible())) {
          continue;
        }

        const enabled = await locator.evaluate((element) => {
          if (!(element instanceof HTMLElement)) {
            return false;
          }

          if (element.getAttribute('aria-disabled') === 'true') {
            return false;
          }

          if ('disabled' in element && (element as HTMLButtonElement).disabled) {
            return false;
          }

          return true;
        });

        if (enabled) {
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

async function prepareXHeadlessSession(context: import('playwright').BrowserContext) {
  await context.addInitScript(() => {
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    const brands = [
      { brand: 'Google Chrome', version: '145' },
      { brand: 'Chromium', version: '145' },
      { brand: 'Not=A?Brand', version: '24' },
    ];

    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });

    Object.defineProperty(navigator, 'userAgent', {
      get: () => userAgent,
      configurable: true,
    });

    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands,
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: async () => ({
          architecture: 'x86',
          bitness: '64',
          brands,
          fullVersionList: brands,
          mobile: false,
          model: '',
          platform: 'macOS',
          platformVersion: '15.0.0',
          uaFullVersion: '145.0.0.0',
        }),
        toJSON: () => ({
          brands,
          mobile: false,
          platform: 'macOS',
        }),
      }),
      configurable: true,
    });
  });
}

async function readXSubmissionResult(response: import('playwright').Response) {
  try {
    const payload = await response.json();
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    if (errors.length === 0) {
      if (payload?.data && Object.keys(payload.data).length > 0) {
        return {
          error: null,
          tweetId: extractXCreatedTweetId(payload),
        };
      }

      return {
        error: 'X returned an empty publish response, and the post was not confirmed.',
        tweetId: null,
      };
    }

    const firstError = errors[0] as {
      code?: number;
      message?: string;
      extensions?: { code?: number };
    };
    const code = firstError.code ?? firstError.extensions?.code;
    const message = typeof firstError.message === 'string' ? firstError.message : 'Unknown X publish error.';

    if (code === 226) {
      return {
        error: 'X blocked this publish as automated (code 226). The saved X session needs a less detectable browser mode or a manual retry in X.',
        tweetId: null,
      };
    }

    return {
      error: `X rejected the publish request: ${message}${code ? ` (code ${code})` : ''}`,
      tweetId: null,
    };
  } catch {
    return {
      error: null,
      tweetId: null,
    };
  }
}

function extractXCreatedTweetId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const typedPayload = payload as {
    data?: {
      create_tweet?: {
        tweet_results?: {
          result?: {
            rest_id?: string;
          };
        };
      };
    };
  };

  return typedPayload.data?.create_tweet?.tweet_results?.result?.rest_id ?? null;
}
