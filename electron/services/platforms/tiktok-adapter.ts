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
    'button[data-e2e="post_video_button"]',
    'button[data-e2e="post_video_button"] .Button__content',
    'button:has-text("Publish")',
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
  continuePostButton: [
    'button:has-text("Post now")',
    '[role="button"]:has-text("Post now")',
    'button:has-text("Continue to post")',
  ],
  successMarkers: [
    'text=Manage posts',
    'text=Upload another video',
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
          await page.goto('https://www.tiktok.com/tiktokstudio/upload?from=webapp', {
            waitUntil: 'domcontentloaded',
          });

          await options.onProgress?.('Uploading the TikTok video');
          await setInputFilesFirst(page, tiktokSelectors.fileInput, [video.path], 12_000);
          capture.appendNote(`TikTok video queued: ${video.path}`);

          if (options.payload.body.trim()) {
            await options.onProgress?.('Adding the TikTok caption');
            await fillFirst(page, tiktokSelectors.caption, options.payload.body, 8_000);
          }

          await options.onProgress?.('Waiting for TikTok to enable posting');
          const postButtonSelector = await waitForReadyTikTokPostButton(page, 45_000);
          capture.appendNote(`TikTok post button ready through: ${postButtonSelector ?? 'not found'}`);
          if (!postButtonSelector) {
            return fail('TikTok never enabled the Post button after the video upload.');
          }

          // Listen for the create API response and success markers BEFORE clicking Post
          const createResponse = page
            .waitForResponse(
              (response) =>
                response.request().method() === 'POST' &&
                (response.url().includes('/api/post/item_create/') ||
                  response.url().includes('/web/project/post/create/') ||
                  response.url().includes('/api/post/publish/')),
              { timeout: 30_000 },
            )
            .catch(() => null);

          const successMarkerPromise = waitForAnySelector(page, tiktokSelectors.successMarkers, 30_000);
          const urlChangePromise = page.waitForURL((url) => !url.toString().includes('/upload'), { timeout: 30_000 }).then(() => true).catch(() => false);

          await clickTikTokPostButton(page, postButtonSelector);
          capture.appendNote(`TikTok submit clicked by selector: ${postButtonSelector}`);

          // TikTok may show a "Continue to post?" modal — handle it in parallel
          const continuePostWatcher = (async () => {
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
              const clicked = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                for (const btn of btns) {
                  const text = btn.textContent?.trim() ?? '';
                  if (text === 'Post now' || text === 'Post Now') {
                    if (btn instanceof HTMLElement) { btn.click(); return text; }
                  }
                }
                return null;
              });
              if (clicked) return clicked;
              await page.waitForTimeout(500);
            }
            return null;
          })();

          await options.onProgress?.('Posting to TikTok');

          // Race: whichever confirms first wins
          const result = await Promise.race([
            createResponse.then(async (response) => {
              if (!response) return null;
              const submission = await readTikTokSubmissionResult(response);
              if (submission.ok) return { type: 'api', success: true } as const;
              if (!response.ok()) return { type: 'api', success: false, detail: `TikTok rejected the upload with HTTP ${response.status()}.` } as const;
              return { type: 'api', success: false, detail: submission.detail } as const;
            }),
            successMarkerPromise.then((marker) => marker ? { type: 'marker', success: true } as const : null),
            urlChangePromise.then((changed) => changed ? { type: 'url', success: true } as const : null),
          ]);

          void continuePostWatcher.then((clicked) => {
            if (clicked) capture.appendNote(`TikTok "Continue to post?" dismissed with: ${clicked}`);
          });

          if (result?.success) {
            capture.appendNote(`TikTok confirmed via: ${result.type}`);
            const postUrl = await extractTikTokPostUrl(page);
            return this.buildSuccess(this.platform, 'Published on TikTok.', postUrl);
          }

          if (result && !result.success && 'detail' in result && result.detail) {
            return fail(result.detail);
          }

          // If race returned null, wait for any remaining signal
          const fallback = await Promise.race([
            createResponse,
            successMarkerPromise,
          ]);

          if (fallback) {
            const postUrl = await extractTikTokPostUrl(page);
            return this.buildSuccess(this.platform, 'Published on TikTok.', postUrl);
          }

          return fail(
            'TikTok did not confirm the post was created.',
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
  const clickedByName = await clickNamedButton(page, ['Got it'], 1500).catch(() => null);
  if (clickedByName) {
    capture.appendNote(`Dismissed TikTok blocking modal with: ${clickedByName}`);
  }
}

async function waitForReadyTikTokPostButton(
  page: import('playwright').Page,
  timeout: number,
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of tiktokSelectors.postButton) {
      const locator = page.locator(selector);
      try {
        const count = await locator.count();
        for (let index = 0; index < count; index += 1) {
          const candidate = locator.nth(index);
          if (!(await candidate.isVisible())) {
            continue;
          }

          const enabled = await candidate.evaluate((element) => {
            if (!(element instanceof HTMLElement)) {
              return false;
            }

            if (element.getAttribute('aria-disabled') === 'true') {
              return false;
            }

            if (element.getAttribute('data-disabled') === 'true') {
              return false;
            }

            if ('disabled' in element && (element as HTMLButtonElement).disabled) {
              return false;
            }

            return true;
          });

          if (enabled) {
            if (selector.includes('.Button__content')) {
              return 'button[data-e2e="post_video_button"]';
            }
            return selector;
          }
        }
      } catch {
        continue;
      }
    }

    await page.waitForTimeout(400);
  }

  return null;
}

async function readTikTokSubmissionResult(response: import('playwright').Response) {
  try {
    const payload = await response.json();
    const success =
      payload?.statusCode === 0 ||
      payload?.status_code === 0 ||
      payload?.code === 0 ||
      payload?.success === true ||
      payload?.status === 'success' ||
      payload?.data?.status === 'success';

    if (success) {
      return { ok: true, detail: null as string | null };
    }

    const detail =
      payload?.statusMsg ??
      payload?.status_msg ??
      payload?.message ??
      payload?.msg ??
      'TikTok returned a post response, but it did not indicate success.';

    return { ok: false, detail };
  } catch {
    return {
      ok: response.ok(),
      detail: response.ok() ? null : `TikTok rejected the post with HTTP ${response.status()}.`,
    };
  }
}

async function extractTikTokPostUrl(page: import('playwright').Page): Promise<string | null> {
  try {
    // After posting, TikTok may show "Manage posts" with a link to the video,
    // or redirect to the video page.
    await page.waitForTimeout(2000);
    const url = page.url();

    // If we're on a video page already, use it
    if (url.includes('/video/')) return url;

    // Look for a link to the posted video on the success/manage posts page
    const postUrl = await page.evaluate(() => {
      // "Manage posts" page may have links to the video
      const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      if (links.length > 0) {
        return (links[0] as HTMLAnchorElement).href;
      }
      // Try to find the username for building a profile URL at minimum
      const profileLink = document.querySelector('a[href*="/@"]');
      if (profileLink) {
        return (profileLink as HTMLAnchorElement).href;
      }
      return null;
    });

    return postUrl;
  } catch {
    return null;
  }
}

async function clickTikTokPostButton(
  page: import('playwright').Page,
  selector: string,
) {
  const button =
    selector === 'button[data-e2e="post_video_button"]'
      ? page.locator('button[data-e2e="post_video_button"]').first()
      : page.locator(selector).first();

  await button.click({ timeout: 2_000 }).catch(async () => {
    await page.evaluate(() => {
      const cancelModal = Array.from(document.querySelectorAll('div[role="dialog"]')).find((dialog) =>
        dialog.textContent?.includes('Sure you want to cancel your upload?'),
      );
      if (!cancelModal) {
        return;
      }

      const keepEditing = Array.from(cancelModal.querySelectorAll('button')).find((button) =>
        button.textContent?.trim() === 'No',
      );
      if (keepEditing instanceof HTMLElement) {
        keepEditing.click();
      }
    });

    await page.locator('button[data-e2e="post_video_button"]').first().click({ timeout: 2_000, force: true });
  });
}
