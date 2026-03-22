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
    'a:has(svg[aria-label="New post"])',
    'a[role="link"]:has(svg[aria-label="New post"])',
    '[role="button"]:has(svg[aria-label="New post"])',
    'a[href="/create/select/"]',
    'a[href*="/create/"]',
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
    'button[aria-label="Next"]',
    '[role="button"][aria-label="Next"]',
    'svg[aria-label="Next"]',
    'button:has-text("Next")',
    'button:has-text("Continue")',
    '[role="button"]:has-text("Next")',
    '[role="button"]:has-text("Continue")',
    'a:has-text("Next")',
    'a:has-text("Continue")',
  ],
  caption: ['textarea[aria-label="Write a caption..."]', 'textarea'],
  shareButton: [
    'button[aria-label="Share"]',
    '[role="button"][aria-label="Share"]',
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

        const hasVideo = options.payload.assets.some((asset) => asset.mediaKind === 'video');

        const result = await this.withOperationTimeout(async () => {
          const files = options.payload.assets.map((asset) => asset.path);
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
              ? 'Waiting for Instagram to process the video (up to 2 min)'
              : 'Waiting for Instagram to finish processing the media',
          );
          const stage = await waitForInstagramStage(page, processingTimeout);
          if (stage === null) {
            throw new Error(
              hasVideo
                ? 'Instagram did not reach the next editing step within 2 minutes after the video upload.'
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
  await tryDismissInstagramInterruptions(page);

  // 1. Click the sidebar Create button by targeting the SVG with aria-label="New post".
  //    Use Playwright's real mouse click (not DOM .click()) so React handlers fire.
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null);

  let clickedCreate = false;
  try {
    const svg = page.locator('svg[aria-label="New post"]').first();
    await svg.waitFor({ state: 'attached', timeout: 8000 });
    await svg.click({ timeout: 3000, force: true });
    clickedCreate = true;
  } catch {
    // Fallback: try clicking by text "Create" in the sidebar
    try {
      await page.locator('span:has-text("Create")').first().click({ timeout: 3000, force: true });
      clickedCreate = true;
    } catch {
      clickedCreate = false;
    }
  }

  if (!clickedCreate) {
    return null;
  }

  // 2. Wait for the create dialog to appear — it either opens a file chooser
  //    or shows a dialog with a file input or a Post/Reel menu.
  await page.waitForTimeout(1500);

  // Try the file chooser first (Instagram may open a native dialog directly)
  const fileInput = await trySetInstagramFiles(page, files);
  if (fileInput) {
    return fileInput;
  }

  const chooser = await resolveInstagramChooser(chooserPromise, files);
  if (chooser) {
    return chooser;
  }

  // 3. A Post/Reel menu may have appeared — pick Post.
  const menuChooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  const pickedType =
    (await tryClickInstagramAction(page, ['Post'], 3000)) ??
    (await tryClickFirst(page, instagramSelectors.createMenuEntry, 3000)) ??
    (await tryClickInstagramAction(page, ['Reel'], 3000));

  if (pickedType) {
    await page.waitForTimeout(1000);

    const inputAfterMenu = await trySetInstagramFiles(page, files);
    if (inputAfterMenu) {
      return inputAfterMenu;
    }

    const chooserAfterMenu = await resolveInstagramChooser(menuChooserPromise, files);
    if (chooserAfterMenu) {
      return chooserAfterMenu;
    }
  }

  // 4. Last resort — look for any file input on the page.
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
    const inputSelector = await findVisibleInstagramInput(page);
    if (inputSelector) {
      return 'file-input';
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
  const clickedByAccessibleName = await tryClickInstagramAccessibleAction(page, labels, timeout);
  if (clickedByAccessibleName) {
    return clickedByAccessibleName;
  }

  const selectors = labels.flatMap((label) => [
    `button[aria-label="${label}"]`,
    `[role="button"][aria-label="${label}"]`,
    `svg[aria-label="${label}"]`,
    `button:has-text("${label}")`,
    `[role="button"]:has-text("${label}")`,
    `[role="menuitem"]:has-text("${label}")`,
    `a:has-text("${label}")`,
  ]);

  const clickedBySelector = await tryClickAnyVisibleInstagramSelector(page, selectors, timeout);
  if (clickedBySelector) {
    return clickedBySelector;
  }

  return tryClickNamedButton(page, labels, timeout);
}

async function waitForInstagramStage(
  page: import('playwright').Page,
  timeout: number,
): Promise<'advance' | 'compose' | null> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (
      (await hasVisibleSelector(page, instagramSelectors.caption)) ||
      (await hasInstagramAccessibleAction(page, ['Share', 'Post']))
    ) {
      return 'compose';
    }

    if (
      (await hasInstagramAccessibleAction(page, ['Next', 'Continue'])) ||
      (await hasVisibleSelector(page, instagramSelectors.nextButton))
    ) {
      return 'advance';
    }

    await page.waitForTimeout(400);
  }

  return null;
}

async function hasVisibleSelector(page: import('playwright').Page, selectors: string[]) {
  return (await findVisibleSelector(page, selectors)) !== null;
}

async function findVisibleSelector(page: import('playwright').Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    try {
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        if (await locator.nth(index).isVisible()) {
          return selector;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function tryClickAnyVisibleInstagramSelector(
  page: import('playwright').Page,
  selectors: string[],
  timeout: number,
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
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

            if ('disabled' in element && (element as HTMLButtonElement).disabled) {
              return false;
            }

            return true;
          });

          if (!enabled) {
            continue;
          }

          await candidate.click({ timeout: 1500 });
          return selector;
        }
      } catch {
        continue;
      }
    }

    await page.waitForTimeout(300);
  }

  return null;
}

async function hasInstagramAccessibleAction(
  page: import('playwright').Page,
  labels: string[],
) {
  return (await findInstagramAccessibleAction(page, labels)) !== null;
}

async function tryClickInstagramAccessibleAction(
  page: import('playwright').Page,
  labels: string[],
  timeout: number,
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const action = await findInstagramAccessibleAction(page, labels);
    if (action) {
      await action.locator.click({ timeout: 1500 });
      return `${action.role}:${action.label}`;
    }

    await page.waitForTimeout(300);
  }

  return null;
}

async function findInstagramAccessibleAction(
  page: import('playwright').Page,
  labels: string[],
) {
  const roles: Array<'button' | 'link' | 'menuitem'> = ['button', 'link', 'menuitem'];

  for (const label of labels) {
    const name = new RegExp(`^${escapeRegex(label)}$`, 'i');
    for (const role of roles) {
      const locator = page.getByRole(role, { name });
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

            if ('disabled' in element && (element as HTMLButtonElement).disabled) {
              return false;
            }

            return true;
          });

          if (enabled) {
            return { locator: candidate, label, role };
          }
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function tryClickInstagramAccessibleLink(
  page: import('playwright').Page,
  labels: string[],
  timeout: number,
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const label of labels) {
      const name = new RegExp(`^${escapeRegex(label)}$`, 'i');
      const locator = page.getByRole('link', { name });
      try {
        const count = await locator.count();
        for (let index = 0; index < count; index += 1) {
          const candidate = locator.nth(index);
          if (await candidate.isVisible()) {
            await candidate.click({ timeout: 1500 });
            return `link:${label}`;
          }
        }
      } catch {
        continue;
      }
    }

    await page.waitForTimeout(300);
  }

  return null;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
