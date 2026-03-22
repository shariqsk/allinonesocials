import type { Locator, Page } from 'playwright';

export async function clickFirst(page: Page, selectors: string[], timeout = 1500) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      await locator.click({ timeout });
      return selector;
    } catch {
      continue;
    }
  }

  throw new Error(`Could not click any selector: ${selectors.join(', ')}`);
}

export async function tryClickFirst(page: Page, selectors: string[], timeout = 1500) {
  try {
    return await clickFirst(page, selectors, timeout);
  } catch {
    return null;
  }
}

export async function fillFirst(page: Page, selectors: string[], value: string, timeout = 1500) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      await writeValue(locator, value);
      return selector;
    } catch {
      continue;
    }
  }

  throw new Error(`Could not fill any selector: ${selectors.join(', ')}`);
}

export async function setInputFilesFirst(page: Page, selectors: string[], files: string[], timeout = 2000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'attached', timeout });
      await locator.setInputFiles(files, { timeout });
      return selector;
    } catch {
      continue;
    }
  }

  throw new Error(`Could not find a file input for selectors: ${selectors.join(', ')}`);
}

export async function waitForAnySelector(page: Page, selectors: string[], timeout = 3000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return selector;
    } catch {
      continue;
    }
  }

  return null;
}

export function firstMatchingSelector(document: Document, selectors: string[]) {
  for (const selector of selectors) {
    if (document.querySelector(selector)) {
      return selector;
    }
  }

  return null;
}

async function writeValue(locator: Locator, value: string) {
  try {
    await locator.fill(value);
    return;
  } catch {
    // Fall through to contenteditable support.
  }

  await locator.evaluate((element, text) => {
    if (element instanceof HTMLElement) {
      element.focus();
      if ('value' in element) {
        (element as HTMLInputElement | HTMLTextAreaElement).value = text;
      } else {
        element.textContent = text;
      }

      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, value);
}
