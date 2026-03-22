import {
  clickFirst,
  clickFirstReady,
  clickNamedButton,
  fillFirst,
  setInputFilesFirst,
  tryClickFirst,
  tryClickNamedButton,
} from './adapter-utils';
import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

const instagramSelectors = {
  loggedInMarkers: [
    'a[href="/create/select/"]',
    '[aria-label="New post"]',
    'svg[aria-label="New post"]',
    'a[href="/direct/inbox/"]',
    'svg[aria-label="Home"]',
  ],
  createButton: [
    'a[href="/create/select/"]',
    'a[href*="/create/"]',
    '[aria-label="New post"]',
    'svg[aria-label="New post"]',
    '[role="button"][aria-label="New post"]',
  ],
  createMenuEntry: [
    'text="Post"',
    'text="Reel"',
    'button:has-text("Post")',
    '[role="button"]:has-text("Post")',
    '[role="menuitem"]:has-text("Post")',
    'a:has-text("Post")',
    'button:has-text("Reel")',
    '[role="button"]:has-text("Reel")',
    '[role="menuitem"]:has-text("Reel")',
    'a:has-text("Reel")',
  ],
  fileInput: ['input[type="file"]', 'input[accept*="image"]', 'input[accept*="video"]', 'input[multiple]'],
  nextButton: [
    'button:has-text("Next")',
    'button:has-text("Continue")',
    '[role="button"]:has-text("Next")',
    '[role="button"]:has-text("Continue")',
    'a:has-text("Next")',
    'a:has-text("Continue")',
  ],
  caption: ['textarea[aria-label="Write a caption..."]', 'textarea'],
  shareButton: [
    'button:has-text("Share")',
    'button:has-text("Post")',
    '[role="button"]:has-text("Share")',
    '[role="button"]:has-text("Post")',
    'a:has-text("Share")',
  ],
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
    }, { headless: true });
  }

  async publish(options: PublishOptions) {
    if (options.payload.assets.length === 0) {
      return this.buildFailure(this.platform, 'Instagram publishing requires at least one image or video.');
    }

    try {
      return await this.withContext(options.secret.profileDir, async (context, page) => {
        const capture = await this.startDebugCapture(context, page, options.secret.profileDir, this.platform);
        const fail = (message: string) => this.buildFailureWithArtifacts(this.platform, message, page, capture);

        const result = await this.withOperationTimeout(async () => {
          const files = options.payload.assets.map((asset) => asset.path);
          const hasVideo = options.payload.assets.some((asset) => asset.mediaKind === 'video');
          const processingTimeout = hasVideo ? 60_000 : 25_000;
          const shareTimeout = hasVideo ? 30_000 : 15_000;

          await options.onProgress?.('Opening Instagram create flow');
          capture.appendNote('Navigating to Instagram home');
          await page.goto(this.homeUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 15_000,
          });

          if (!(await this.isAuthenticated(context, page))) {
            return fail(
              'Login expired or Instagram still needs a manual checkpoint. Reconnect before publishing.',
            );
          }

          await options.onProgress?.('Uploading media to Instagram');
          const uploadMethod = await openInstagramUploadFlow(page, files);
          if (!uploadMethod) {
            throw new Error(
              'Could not open Instagram upload from the home create flow or find an upload input.',
            );
          }
          capture.appendNote(`Instagram upload method: ${uploadMethod}`);

          await options.onProgress?.(
            hasVideo
              ? 'Waiting for Instagram to process the video (up to 60s)'
              : 'Waiting for Instagram to finish processing the media',
          );
          const stage = await waitForInstagramStage(page, processingTimeout);
          if (stage === null) {
            throw new Error(
              hasVideo
                ? 'Instagram did not reach the next editing step within 60 seconds after the video upload.'
                : 'Instagram did not reach the next editing step after the upload.',
            );
          }

          if (stage === 'advance') {
            const firstNext = await tryClickInstagramAction(page, ['Next', 'Continue'], shareTimeout);
            if (!firstNext) {
              await clickFirstReady(page, instagramSelectors.nextButton, shareTimeout);
            }

            await waitForInstagramStage(page, 10_000);
            await tryClickInstagramAction(page, ['Next', 'Continue'], 10_000);
          }

          const readyForCaptionOrShare = await waitForInstagramStage(page, shareTimeout);
          if (readyForCaptionOrShare === null) {
            throw new Error('Instagram never reached the editor or share step after the upload.');
          }
          capture.appendNote(`Instagram editor/share stage: ${readyForCaptionOrShare}`);

          if (options.payload.body.trim()) {
            await options.onProgress?.('Adding the Instagram caption');
            await fillFirst(page, instagramSelectors.caption, options.payload.body, 6000);
          }

          await options.onProgress?.(
            hasVideo
              ? 'Waiting for Instagram to enable Share (up to 30s)'
              : 'Waiting for Instagram to enable Share',
          );
          const clickedShare = await tryClickInstagramAction(page, ['Share', 'Post'], shareTimeout);
          if (!clickedShare) {
            await clickFirstReady(page, instagramSelectors.shareButton, shareTimeout);
            capture.appendNote('Instagram share clicked by selector fallback');
          } else {
            capture.appendNote(`Instagram share clicked by action: ${clickedShare}`);
          }
          await page.waitForTimeout(1000);

          return this.buildSuccess(this.platform, 'Published on Instagram.', page.url());
        }, 80_000, 'Instagram publish timed out before reaching the share confirmation step.', options.signal)
          .catch((error) => fail(error instanceof Error ? error.message : 'Instagram publishing failed.'));

        await capture.stop();
        return result;
      }, { headless: true, signal: options.signal });
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

async function trySetInstagramFiles(page: import('playwright').Page, files: string[]) {
  try {
    return await setInputFilesFirst(page, instagramSelectors.fileInput, files, 8000);
  } catch {
    return null;
  }
}

async function openInstagramUploadFlow(page: import('playwright').Page, files: string[]) {
  await page.goto('https://www.instagram.com/create/select/', {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  }).catch(() => null);

  const directInput = await trySetInstagramFiles(page, files);
  if (directInput) {
    return directInput;
  }

  await tryDismissInstagramInterruptions(page);

  const createUrlChooser = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
  const createUrlChooserResult = await resolveInstagramChooser(createUrlChooser, files);
  if (createUrlChooserResult) {
    return createUrlChooserResult;
  }

  const directChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  const createOpened =
    (await tryClickFirst(page, instagramSelectors.createButton, 8000)) ??
    (await tryClickNamedButton(page, ['Create', 'New post'], 8000));

  if (!createOpened) {
    return null;
  }

  const directCreateSurface = await waitForInstagramCreateSurface(page, 5000);
  if (directCreateSurface) {
    if (directCreateSurface === 'url') {
      return trySetInstagramFiles(page, files);
    }
    return directCreateSurface;
  }

  const directChooser = await resolveInstagramChooser(directChooserPromise, files);
  if (directChooser) {
    return directChooser;
  }

  const chooserAfterMenuPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  const pickedCreateType =
    (await tryClickInstagramAction(page, ['Post'], 5000)) ??
    (await tryClickFirst(page, instagramSelectors.createMenuEntry, 5000)) ??
    (await tryClickInstagramAction(page, ['Reel'], 5000));

  if (pickedCreateType) {
    const createSurface = await waitForInstagramCreateSurface(page, 5000);
    if (createSurface) {
      if (createSurface === 'url') {
        return trySetInstagramFiles(page, files);
      }
      return createSurface;
    }

    const chooserAfterMenu = await resolveInstagramChooser(chooserAfterMenuPromise, files);
    if (chooserAfterMenu) {
      return chooserAfterMenu;
    }
  }

  return trySetInstagramFiles(page, files);
}

async function resolveInstagramChooser(
  chooserPromise: Promise<import('playwright').FileChooser | null>,
  files: string[],
) {
  const chooser = await chooserPromise;
  if (!chooser) {
    return null;
  }

  await chooser.setFiles(files);
  return 'filechooser';
}

async function waitForInstagramCreateSurface(
  page: import('playwright').Page,
  timeout: number,
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (page.url().includes('/create/')) {
      return 'url';
    }

    const inputSelector = await findVisibleInstagramInput(page);
    if (inputSelector) {
      return inputSelector;
    }

    await page.waitForTimeout(250);
  }

  return null;
}

async function findVisibleInstagramInput(page: import('playwright').Page) {
  for (const selector of instagramSelectors.fileInput) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0) {
        return selector;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function tryDismissInstagramInterruptions(page: import('playwright').Page) {
  await tryClickInstagramAction(page, ['Not Now', 'Cancel'], 1500);
}

async function tryClickInstagramAction(
  page: import('playwright').Page,
  labels: string[],
  timeout: number,
) {
  const clickedByRole = await tryClickNamedButton(page, labels, timeout);
  if (clickedByRole) {
    return clickedByRole;
  }

  const selectors = labels.flatMap((label) => [
    `button:has-text("${label}")`,
    `[role="button"]:has-text("${label}")`,
    `[role="menuitem"]:has-text("${label}")`,
    `a:has-text("${label}")`,
  ]);

  return tryClickFirst(page, selectors, timeout);
}

async function waitForInstagramStage(
  page: import('playwright').Page,
  timeout: number,
): Promise<'advance' | 'compose' | null> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await hasVisibleSelector(page, [...instagramSelectors.caption, ...instagramSelectors.shareButton])) {
      return 'compose';
    }

    if (await hasVisibleSelector(page, instagramSelectors.nextButton)) {
      return 'advance';
    }

    await page.waitForTimeout(400);
  }

  return null;
}

async function hasVisibleSelector(page: import('playwright').Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}
