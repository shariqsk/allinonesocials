import {
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
          await options.onProgress?.('Creating post');
          await dismissPopups(page);
          if (!(await mouseClickElement(page, 'svg[aria-label="New post"]', 5000))) {
            throw new Error('Could not find the Instagram Create button.');
          }
          capture.appendNote('Clicked Create button');
          await page.waitForTimeout(800);

          // Step 3: Click "Post" from the create menu
          if (!(await mouseClickElement(page, 'svg[aria-label="Post"]', 5000)) &&
              !(await mouseClickElement(page, 'svg[aria-label="Reel"]', 3000))) {
            throw new Error('Could not find Post or Reel option in the create menu.');
          }
          capture.appendNote('Clicked Post/Reel menu option');
          await page.waitForTimeout(800);

          // Step 4: Upload files
          await options.onProgress?.('Uploading media');
          const uploaded = await uploadFiles(page, files);
          if (!uploaded) {
            throw new Error('Could not find a file input to upload media.');
          }
          capture.appendNote(`Uploaded files via: ${uploaded}`);

          // Step 5: Wait for media to be processed on the crop screen.
          // Instagram needs time to load the media preview. Wait for the
          // Next button to appear, which signals processing is done.
          await waitForDialogButton(page, ['Next', 'Continue'], 15_000);
          capture.appendNote('Media loaded, Next button visible');

          // Step 6: Navigate through screens (crop → edit → compose)
          await options.onProgress?.('Preparing post');
          const maxSteps = 6;
          for (let step = 0; step < maxSteps; step += 1) {
            await dismissPopups(page);

            // Check for Instagram error
            const error = await checkForError(page);
            if (error) {
              capture.appendNote(`Error at step ${step}: ${error}`);
              // Try clicking "Try again"
              const retried = await clickDialogButtonByText(page, 'Try again');
              if (retried) {
                capture.appendNote('Clicked Try again');
                await page.waitForTimeout(2000);
                continue;
              }
              throw new Error(`Instagram error: ${error}`);
            }

            const state = await getDialogState(page);
            capture.appendNote(`Step ${step}: ${JSON.stringify(state)}`);

            if (state.hasShare) break; // Reached compose screen

            if (state.hasNext) {
              const clicked = await clickDialogButtonBySvg(page, 'Next') ||
                              await clickDialogButtonByText(page, 'Next');
              capture.appendNote(`Clicked Next: ${clicked}`);
              // Wait for the screen transition to complete
              await page.waitForTimeout(1500);
              continue;
            }

            if (state.hasContinue) {
              await clickDialogButtonBySvg(page, 'Continue') ||
                await clickDialogButtonByText(page, 'Continue');
              await page.waitForTimeout(1500);
              continue;
            }

            if (state.exists) {
              // Dialog exists but no recognized button — media might still be loading
              await page.waitForTimeout(1000);
              continue;
            }

            // No dialog — check for error one more time
            const lateError = await checkForError(page);
            if (lateError) {
              throw new Error(`Instagram error: ${lateError}`);
            }
            throw new Error('Instagram create dialog disappeared unexpectedly.');
          }

          // Verify we reached the share screen
          const finalState = await getDialogState(page);
          if (!finalState.hasShare) {
            const error = await checkForError(page);
            if (error) throw new Error(`Instagram error: ${error}`);
            throw new Error('Instagram never reached the share screen.');
          }

          // Step 7: Fill caption
          if (options.payload.body.trim()) {
            await options.onProgress?.('Adding caption');
            await fillCaptionInDialog(page, options.payload.body);
            capture.appendNote('Caption filled');
          }

          // Step 8: Set up network listener for publish confirmation BEFORE clicking Share.
          // Track ALL POST requests so we can log what was sent.
          const postRequests: string[] = [];
          page.on('response', (response) => {
            if (response.request().method() === 'POST' && response.url().includes('instagram.com')) {
              postRequests.push(`${response.status()} ${response.url().split('?')[0]}`);
            }
          });

          let gotPublishApiResponse = false;
          const publishResponse = page
            .waitForResponse(
              (response) => {
                if (response.request().method() !== 'POST') return false;
                const url = response.url();
                const isPublish = url.includes('/create/') ||
                  url.includes('/publish/') ||
                  url.includes('/configure_sidecar/') ||
                  url.includes('/configure_to_reel/') ||
                  url.includes('/web_create/') ||
                  url.includes('/configure/');
                if (isPublish) gotPublishApiResponse = true;
                return isPublish;
              },
              { timeout: 30_000 },
            )
            .catch(() => null);

          // Step 9: Click Share
          await options.onProgress?.('Sharing');
          let shareClicked = false;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const clicked = await clickDialogButtonBySvg(page, 'Share') ||
                            await clickDialogButtonByText(page, 'Share');
            capture.appendNote(`Share click ${attempt}: ${clicked}`);
            if (!clicked && attempt === 0) {
              throw new Error('Could not find the Share button.');
            }
            if (!clicked) break;
            shareClicked = true;

            // Check if Instagram started sharing (dialog text changes to "Sharing")
            await page.waitForTimeout(2000);
            const sharingState = await getDialogTextState(page);
            capture.appendNote(`Post-share state: ${sharingState}`);
            if (sharingState === 'sharing' || sharingState === 'success') {
              break;
            }
            if (sharingState === 'error') {
              const error = await checkForError(page);
              throw new Error(`Instagram error while sharing: ${error ?? 'Unknown error'}`);
            }
            if (sharingState === 'closed') {
              // Dialog closed immediately — suspicious. Check if API was actually called.
              await page.waitForTimeout(1000);
              if (gotPublishApiResponse) break;
              // No API call = Share didn't actually work. Capture screenshot.
              capture.appendNote(`Dialog closed but no publish API call. POST requests: ${postRequests.join(' | ')}`);
              await capture.persistFailureArtifacts(page, 'Share button clicked but dialog closed without publishing.');
              throw new Error('Share button clicked but Instagram did not start publishing. The click may not have registered.');
            }
            // Still on compose — retry click
            capture.appendNote('Share click did not take, retrying');
          }

          if (!shareClicked) {
            throw new Error('Share button could not be clicked.');
          }

          // Step 10: Wait for publish to complete.
          // ONLY consider it successful with positive confirmation:
          // - API response to a publish endpoint
          // - Success dialog text ("has been shared", "Post shared", "Reel shared")
          // - Redirect to a post URL (/p/ or /reel/)
          // Dialog simply closing is NOT sufficient.
          let confirmed = false;
          let postUrl: string | null = null;

          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            // Check for success dialog
            const state = await getDialogTextState(page);
            if (state === 'success') {
              confirmed = true;
              capture.appendNote('Confirmed via success dialog');
              break;
            }
            if (state === 'error') {
              const error = await checkForError(page);
              throw new Error(`Instagram error: ${error ?? 'Post failed'}`);
            }

            // Check for post URL redirect
            const currentUrl = page.url();
            if (currentUrl.includes('/p/') || currentUrl.includes('/reel/')) {
              confirmed = true;
              postUrl = currentUrl;
              capture.appendNote(`Confirmed via URL redirect: ${postUrl}`);
              break;
            }

            // Check if API response confirmed publish
            if (gotPublishApiResponse && state === 'closed') {
              confirmed = true;
              capture.appendNote('Confirmed via API response + dialog closed');
              break;
            }

            // If dialog closed without API response, that's not a success
            if (state === 'closed' && !gotPublishApiResponse) {
              capture.appendNote(`Dialog closed without publish API. POST requests: ${postRequests.join(' | ')}`);
              break; // Will fall through to failure
            }

            await page.waitForTimeout(500);
          }

          capture.appendNote(`Final: confirmed=${confirmed}, apiCalled=${gotPublishApiResponse}, posts=${postRequests.join(' | ')}`);

          if (!confirmed) {
            await capture.persistFailureArtifacts(page, 'Instagram did not confirm post was published.');
            throw new Error('Instagram did not confirm the post was published.');
          }

          return this.buildSuccess(this.platform, 'Published on Instagram.', postUrl);
        }, 60_000, 'Instagram publish timed out.', options.signal)
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
// Dialog helpers — all queries run via page.evaluate scoped to role="dialog"
// ---------------------------------------------------------------------------

/** Check any visible dialog for error text. Returns the error message or null. */
async function checkForError(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    for (const dialog of dialogs) {
      const r = dialog.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const text = dialog.textContent ?? '';
      if (text.includes('Something went wrong')) return 'Something went wrong';
      if (text.includes('Unable to publish')) return 'Unable to publish';
      if (text.includes('There was an error')) return 'There was an error';
    }
    return null;
  });
}

/**
 * Find the Instagram create dialog and report what buttons are visible.
 * The create dialog is identified by containing create-flow SVGs.
 */
async function getDialogState(page: Page) {
  return page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));

    const isVisible = (el: Element | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // Indicators that identify this as the create/post dialog
    const createIndicators = ['Crop', 'Back', 'Select crop', 'Open media gallery', 'Next', 'Share', 'Continue'];
    for (const dialog of dialogs) {
      if (!isVisible(dialog)) continue;
      const svgs = Array.from(dialog.querySelectorAll('svg[aria-label]'));
      const svgLabels = svgs.map((s) => s.getAttribute('aria-label')!).filter(Boolean);
      const isCreateDialog = svgLabels.some((l) => createIndicators.includes(l));
      if (!isCreateDialog) continue;

      const hasSvg = (label: string) => svgs.some((s) => s.getAttribute('aria-label') === label && isVisible(s));
      const hasText = (label: string) => {
        const els = Array.from(dialog.querySelectorAll('*'));
        return els.some((el) => el.children.length === 0 && el.textContent?.trim() === label && isVisible(el));
      };

      return {
        exists: true,
        hasNext: hasSvg('Next') || hasText('Next'),
        hasContinue: hasSvg('Continue') || hasText('Continue'),
        hasShare: hasSvg('Share') || hasText('Share'),
        svgLabels,
      };
    }

    // Check if there's ANY visible dialog (could be error dialog, popup, etc.)
    const anyVisible = dialogs.some((d) => isVisible(d));
    return {
      exists: anyVisible,
      hasNext: false,
      hasContinue: false,
      hasShare: false,
      svgLabels: [] as string[],
    };
  });
}

/** Wait for a specific button (by SVG aria-label) to appear in a dialog. */
async function waitForDialogButton(page: Page, labels: string[], timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // Also dismiss popups while waiting (e.g., "Video posts shared as reels")
    await dismissPopups(page);
    const found = await page.evaluate((labelsToFind) => {
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
      for (const dialog of dialogs) {
        const r = dialog.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const svgs = Array.from(dialog.querySelectorAll('svg[aria-label]'));
        for (const label of labelsToFind) {
          if (svgs.some((s) => {
            if (s.getAttribute('aria-label') !== label) return false;
            const sr = s.getBoundingClientRect();
            return sr.width > 0 && sr.height > 0;
          })) return true;
          // Also check text buttons
          const els = Array.from(dialog.querySelectorAll('*'));
          if (els.some((el) => {
            if (el.children.length > 0) return false;
            if (el.textContent?.trim() !== label) return false;
            const er = el.getBoundingClientRect();
            return er.width > 0 && er.height > 0;
          })) return true;
        }
      }
      return false;
    }, labels);
    if (found) return true;

    // Check for error
    const error = await checkForError(page);
    if (error) return false;

    await page.waitForTimeout(500);
  }
  return false;
}

/** Click a button inside the create dialog by SVG aria-label using mouse coordinates. */
async function clickDialogButtonBySvg(page: Page, label: string): Promise<boolean> {
  const coords = await page.evaluate((lbl) => {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    for (const dialog of dialogs) {
      const r = dialog.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const svg = Array.from(dialog.querySelectorAll(`svg[aria-label="${lbl}"]`))
        .find((s) => {
          const sr = s.getBoundingClientRect();
          return sr.width > 0 && sr.height > 0;
        });
      if (svg) {
        const sr = svg.getBoundingClientRect();
        return { x: sr.x + sr.width / 2, y: sr.y + sr.height / 2 };
      }
    }
    return null;
  }, label);
  if (!coords) return false;
  await page.mouse.click(coords.x, coords.y);
  return true;
}

/** Click a button inside any visible dialog by exact text match using mouse coordinates. */
async function clickDialogButtonByText(page: Page, label: string): Promise<boolean> {
  const coords = await page.evaluate((lbl) => {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    for (const dialog of dialogs) {
      const r = dialog.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const els = Array.from(dialog.querySelectorAll('*'));
      const el = els.find((e) => {
        if (e.children.length > 0) return false;
        if (e.textContent?.trim() !== lbl) return false;
        const er = e.getBoundingClientRect();
        return er.width > 0 && er.height > 0;
      });
      if (el) {
        const er = el.getBoundingClientRect();
        return { x: er.x + er.width / 2, y: er.y + er.height / 2 };
      }
    }
    return null;
  }, label);
  if (!coords) return false;
  await page.mouse.click(coords.x, coords.y);
  return true;
}

/** Fill the caption field inside the create dialog. */
async function fillCaptionInDialog(page: Page, text: string) {
  // Click the caption field first to focus it, then type
  const coords = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    for (const dialog of dialogs) {
      const r = dialog.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const field =
        dialog.querySelector('div[aria-label="Write a caption..."]') ??
        dialog.querySelector('textarea[aria-label="Write a caption..."]') ??
        dialog.querySelector('div[contenteditable="true"][role="textbox"]');
      if (field) {
        const fr = field.getBoundingClientRect();
        if (fr.width > 0 && fr.height > 0) {
          return { x: fr.x + fr.width / 2, y: fr.y + fr.height / 2 };
        }
      }
    }
    return null;
  });

  if (coords) {
    await page.mouse.click(coords.x, coords.y);
    await page.waitForTimeout(300);
    await page.keyboard.type(text, { delay: 10 });
  }
}

/** Quick check of what text state the dialog is in after clicking Share. */
async function getDialogTextState(page: Page): Promise<'sharing' | 'success' | 'compose' | 'error' | 'closed'> {
  return page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    for (const d of dialogs) {
      const r = d.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const text = d.textContent ?? '';

      if (text.includes('has been shared') || text.includes('Post shared') || text.includes('Reel shared')) {
        return 'success' as const;
      }
      if (text.includes('Something went wrong') || text.includes('Unable to publish')) {
        return 'error' as const;
      }
      if (text.includes('Sharing')) return 'sharing' as const;

      // Check for Share button still present = still on compose
      const els = Array.from(d.querySelectorAll('*'));
      const hasShareBtn = els.some((el) =>
        el.children.length === 0 && el.textContent?.trim() === 'Share',
      );
      if (hasShareBtn) return 'compose' as const;

      return 'sharing' as const; // Unknown dialog content, assume sharing
    }
    return 'closed' as const;
  });
}

/** Wait for the create/share dialog to close or show a final state. */
async function waitForDialogToClose(
  page: Page,
  timeout: number,
): Promise<{ state: 'closed' | 'success' | 'error' } | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await getDialogTextState(page);
    if (state === 'closed') return { state: 'closed' };
    if (state === 'success') return { state: 'success' };
    if (state === 'error') return { state: 'error' };
    await page.waitForTimeout(500);
  }
  return null;
}

/** Click the first element matching a CSS selector using real mouse coordinates. */
async function mouseClickElement(page: Page, selector: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const box = await page.locator(selector).first().boundingBox();
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
 * Dismiss common Instagram popups/interruptions.
 * Only dismisses safe labels — NOT Cancel/Continue which can interfere with the create flow.
 */
async function dismissPopups(page: Page) {
  await page.evaluate(() => {
    // Only dismiss actual popup buttons, never Cancel/Continue which could close the create dialog
    const safeLabels = ['OK', 'Ok', 'Not Now', 'Got it'];
    const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
    for (const btn of buttons) {
      const text = btn.textContent?.trim();
      if (text && safeLabels.includes(text)) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          (btn as HTMLElement).click();
          return;
        }
      }
    }
  });
}

/** Upload files to the Instagram create dialog via file input or file chooser. */
async function uploadFiles(page: Page, files: string[]): Promise<string | null> {
  // Try setting files directly on a file input
  try {
    return await setInputFilesFirst(page, SELECTORS.fileInput, files, 5000);
  } catch {
    // no file input found
  }

  // Fallback: trigger file chooser via "Select from computer" button
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  const selectBtn = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      const text = btn.textContent?.trim().toLowerCase();
      if (text?.includes('select from computer') || text?.includes('select from device')) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (selectBtn) {
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(files);
      return 'filechooser';
    }
  }

  // Last resort: wait for file input to appear
  try {
    return await setInputFilesFirst(page, SELECTORS.fileInput, files, 8000);
  } catch {
    return null;
  }
}
