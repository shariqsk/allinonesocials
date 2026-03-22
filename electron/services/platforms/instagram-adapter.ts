import {
  fillFirst,
  setInputFilesFirst,
} from './adapter-utils';
import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

type Page = import('playwright').Page;

const SELECTORS = {
  loggedInMarkers: [
    'svg[aria-label="New post"]',
    'svg[aria-label="Home"]',
    'a[href="/direct/inbox/"]',
  ],
  fileInput: [
    'input[type="file"]',
    'input[accept*="image"]',
    'input[accept*="video"]',
    'input[multiple]',
  ],
  caption: [
    'textarea[aria-label="Write a caption..."]',
    'div[aria-label="Write a caption..."]',
    'div[contenteditable="true"][role="textbox"]',
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

          // Step 1: Navigate to Instagram home
          await options.onProgress?.('Opening Instagram');
          capture.appendNote('Navigating to Instagram home');
          await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });

          if (!(await this.isAuthenticated(context, page))) {
            return fail('Login expired or Instagram needs a manual checkpoint. Reconnect before publishing.');
          }

          // Step 2: Click sidebar "Create" button
          await options.onProgress?.('Opening create menu');
          await dismissPopups(page);
          const clickedCreate = await mouseClickElement(page, 'svg[aria-label="New post"]', 5000);
          if (!clickedCreate) {
            throw new Error('Could not find the Instagram Create button in the sidebar.');
          }
          capture.appendNote('Clicked Create button');
          await page.waitForTimeout(1000);

          // Step 3: Click "Post" from the create menu (menu items are <a> with
          //   <svg aria-label="Post"> + <span>Post</span>, so click the SVG icon)
          await options.onProgress?.('Selecting Post type');
          const clickedPost =
            await mouseClickElement(page, 'svg[aria-label="Post"]', 5000) ||
            await mouseClickElement(page, 'svg[aria-label="Reel"]', 3000);
          if (!clickedPost) {
            throw new Error('Could not find Post or Reel option in the create menu.');
          }
          capture.appendNote('Clicked Post/Reel menu option');
          await page.waitForTimeout(1000);

          // Step 4: Upload files
          await options.onProgress?.('Uploading media');
          const uploaded = await uploadFiles(page, files);
          if (!uploaded) {
            throw new Error('Could not find a file input to upload media.');
          }
          capture.appendNote(`Uploaded files via: ${uploaded}`);

          // Step 5: Click through crop screen → Next, edit screen → Next
          // Keep clicking Next/Continue until we reach the caption/share screen.
          // Dismiss any popups at each step (e.g. "Video posts are now shared as reels").
          // IMPORTANT: All selectors must be scoped to the create dialog — the feed
          // behind has its own Next/Share SVGs on carousel posts.
          await options.onProgress?.('Processing media');
          // Wait for Instagram to process the uploaded media and show the crop screen
          await page.waitForTimeout(2000);
          await dismissPopups(page);
          let reachedCompose = false;
          for (let attempt = 0; attempt < 6; attempt += 1) {
            await dismissPopups(page);

            const stage = await detectStage(page, 10_000);
            capture.appendNote(`Stage ${attempt}: ${stage}`);

            if (stage === 'compose') {
              reachedCompose = true;
              break;
            }

            if (stage === 'advance') {
              const clicked =
                await mouseClickElement(page, DIALOG_SELECTOR + ' svg[aria-label="Next"]', 3000) ||
                await mouseClickText(page, 'Next', 3000) ||
                await mouseClickText(page, 'Continue', 3000);
              capture.appendNote(`Clicked advance: ${clicked}`);
              await page.waitForTimeout(500);
              continue;
            }

            // No recognized stage — might still be processing. Wait and retry.
            await page.waitForTimeout(2000);
          }

          if (!reachedCompose) {
            throw new Error('Instagram never reached the caption/share screen after uploading.');
          }

          // Step 6: Fill caption
          if (options.payload.body.trim()) {
            await options.onProgress?.('Adding caption');
            await fillCaption(page, options.payload.body);
            capture.appendNote('Caption filled');
          }

          // Step 7: Click Share and verify it actually published
          await options.onProgress?.('Sharing post');
          await dismissPopups(page);

          // Try clicking Share — if a popup appears, dismiss it and retry
          let shareAttempts = 0;
          let confirmed = false;
          while (shareAttempts < 3 && !confirmed) {
            shareAttempts += 1;
            await dismissPopups(page);

            const clickedShare =
              await mouseClickElement(page, DIALOG_SELECTOR + ' svg[aria-label="Share"]', 5000) ||
              await mouseClickText(page, 'Share', 5000) ||
              await mouseClickText(page, 'Post', 3000);
            if (!clickedShare) {
              // Share button might be gone if the dialog already closed
              break;
            }
            capture.appendNote(`Clicked share attempt ${shareAttempts}: ${clickedShare}`);

            await options.onProgress?.('Waiting for Instagram to confirm');
            confirmed = await waitForShareDialogToClose(page, 30_000);
          }
          if (!confirmed) {
            // Capture what's visible for diagnostics
            const visibleState = await page.evaluate(() => {
              const check = (sel: string) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 ? 'visible' : 'hidden';
              };
              return {
                share: check('svg[aria-label="Share"]'),
                next: check('svg[aria-label="Next"]'),
                crop: check('svg[aria-label="Crop"]'),
                caption: check('div[aria-label="Write a caption..."]') ?? check('textarea[aria-label="Write a caption..."]'),
                url: window.location.href,
              };
            });
            capture.appendNote(`Share failed — visible state: ${JSON.stringify(visibleState)}`);
            throw new Error('Instagram did not confirm the post — the share dialog never closed.');
          }
          capture.appendNote('Share dialog closed — post confirmed');

          // Try to extract the post URL
          const postUrl = await page.evaluate(() => {
            const url = window.location.href;
            if (url.includes('/p/') || url.includes('/reel/')) return url;
            return null;
          });

          return this.buildSuccess(this.platform, 'Published on Instagram.', postUrl);
        }, 120_000, 'Instagram publish timed out.', options.signal)
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

  private async isAuthenticated(
    context: import('playwright').BrowserContext,
    page: Page,
  ) {
    const hasCookies = await this.hasCookies(context, ['sessionid', 'ds_user_id'], [
      this.homeUrl,
      this.loginUrl,
    ]);

    if (hasCookies) {
      return true;
    }

    return this.hasVisibleMarker(page, SELECTORS.loggedInMarkers);
  }
}

// ---------------------------------------------------------------------------
// Core helpers — every click uses page.mouse.click at real bounding box
// coordinates so React event delegation always fires.
// ---------------------------------------------------------------------------

/** Scope selectors to the create dialog — the feed has its own Next/Share SVGs. */
const DIALOG_SELECTOR = 'div[role="dialog"]';

/** Click the first element matching a CSS selector using real mouse coordinates. */
async function mouseClickElement(page: Page, selector: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const locator = page.locator(selector).first();
    try {
      const box = await locator.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
    } catch {
      // element not ready yet
    }
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * Click a visible, enabled button/link/menuitem by its accessible text label
 * using real mouse coordinates.
 */
async function mouseClickText(page: Page, label: string, timeout: number): Promise<string | null> {
  const deadline = Date.now() + timeout;
  const roles: Array<'button' | 'link' | 'menuitem'> = ['button', 'link', 'menuitem'];

  while (Date.now() < deadline) {
    for (const role of roles) {
      const locator = page.getByRole(role, { name: label, exact: true });
      try {
        const count = await locator.count();
        for (let i = 0; i < count; i += 1) {
          const el = locator.nth(i);
          if (!(await el.isVisible())) continue;

          const disabled = await el.evaluate((e) => {
            if (!(e instanceof HTMLElement)) return true;
            if (e.getAttribute('aria-disabled') === 'true') return true;
            if ('disabled' in e && (e as HTMLButtonElement).disabled) return true;
            return false;
          });
          if (disabled) continue;

          const box = await el.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            return `${role}:${label}`;
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

/** Dismiss common Instagram popups/interruptions. */
async function dismissPopups(page: Page) {
  for (const label of ['OK', 'Ok', 'Not Now', 'Cancel', 'Got it', 'Continue']) {
    try {
      const btn = page.getByRole('button', { name: label, exact: true }).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        const box = await btn.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(500);
      }
    } catch {
      // no popup — fine
    }
  }
}

/** Upload files to the Instagram create dialog via file input or file chooser. */
async function uploadFiles(page: Page, files: string[]): Promise<string | null> {
  // Try setting files directly on a file input
  try {
    const result = await setInputFilesFirst(page, SELECTORS.fileInput, files, 5000);
    return result;
  } catch {
    // no file input found
  }

  // Fallback: look for a drag-and-drop zone or "Select from computer" button
  // which triggers a file chooser dialog
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  const clickedSelect = await mouseClickText(page, 'Select from computer', 3000)
    ?? await mouseClickText(page, 'Select from device', 3000)
    ?? await mouseClickText(page, 'Select From Computer', 3000);

  if (clickedSelect) {
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(files);
      return 'filechooser';
    }
  }

  // Last resort: wait for file input to appear after the dialog loads
  try {
    const result = await setInputFilesFirst(page, SELECTORS.fileInput, files, 8000);
    return result;
  } catch {
    return null;
  }
}

/** Fill the caption in Instagram's post editor. Handles both textarea and contenteditable. */
async function fillCaption(page: Page, text: string) {
  for (const selector of SELECTORS.caption) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 3000 })) {
        // Try Playwright fill first
        try {
          await locator.fill(text);
          return;
        } catch {
          // contenteditable — use evaluate
        }
        await locator.evaluate((el, value) => {
          if (el instanceof HTMLElement) {
            el.focus();
            el.textContent = value;
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          }
        }, text);
        return;
      }
    } catch {
      continue;
    }
  }
  // Caption is optional — don't throw if we can't find the field
}

/**
 * Detect which stage the Instagram post editor is in.
 * - 'compose': caption/share screen is showing
 * - 'advance': a Next/Continue button is showing (crop or edit screen)
 * - null: neither detected within timeout
 */
/**
 * After clicking Share, wait for the create dialog to close.
 * The dialog is gone when the Share/Next SVGs and caption textarea are no longer visible.
 * Instagram may show a loading animation during upload — keep waiting until the dialog closes
 * or we see a "Post shared" / "Your reel has been shared" indicator.
 */
async function waitForShareDialogToClose(page: Page, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    // Dismiss any popups that appear during sharing (e.g. "Video posts are now shared as reels")
    await dismissPopups(page);

    // Check if any dialog with create-flow indicators is still visible.
    // We check for the dialog element containing Crop/Share/Next — the feed
    // also has Share/Next SVGs, so we must scope to dialogs only.
    const dialogStillOpen = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
      for (const dialog of dialogs) {
        const rect = dialog.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Check if this dialog contains create-flow indicators
        const hasCreate = dialog.querySelector('svg[aria-label="Share"]')
          ?? dialog.querySelector('svg[aria-label="Next"]')
          ?? dialog.querySelector('svg[aria-label="Crop"]')
          ?? dialog.querySelector('textarea[aria-label="Write a caption..."]')
          ?? dialog.querySelector('div[aria-label="Write a caption..."]');
        if (hasCreate) return true;
      }
      return false;
    });

    if (!dialogStillOpen) {
      return true;
    }

    // Check for error indicators
    const hasError = await page.evaluate(() => {
      const body = document.body.textContent ?? '';
      return body.includes('Something went wrong') || body.includes('Try again');
    });
    if (hasError) {
      return false;
    }

    await page.waitForTimeout(500);
  }

  return false;
}

async function detectStage(page: Page, timeout: number): Promise<'advance' | 'compose' | null> {
  const deadline = Date.now() + timeout;
  const dialog = page.locator(DIALOG_SELECTOR).first();

  while (Date.now() < deadline) {
    // IMPORTANT: all selectors scoped to the create dialog — the feed behind
    // has its own Next/Share/etc SVGs on carousel posts that would match.
    // Check advance FIRST — if Next is visible, we must advance.
    try {
      if (await dialog.locator('svg[aria-label="Next"]').first().isVisible({ timeout: 200 })) return 'advance';
    } catch { /* continue */ }
    try {
      if (await dialog.locator('svg[aria-label="Continue"]').first().isVisible({ timeout: 200 })) return 'advance';
    } catch { /* continue */ }

    // Compose stage: ONLY the Share SVG (within dialog) is a reliable indicator.
    try {
      if (await dialog.locator('svg[aria-label="Share"]').first().isVisible({ timeout: 200 })) return 'compose';
    } catch { /* continue */ }

    await page.waitForTimeout(500);
  }

  return null;
}
