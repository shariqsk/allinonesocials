import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { firstMatchingSelector } from './adapter-utils';

describe('adapter selector fixtures', () => {
  it('finds the X composer selector in a representative fixture', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <div role="textbox" data-testid="tweetTextarea_0"></div>
        </body>
      </html>
    `);

    expect(
      firstMatchingSelector(dom.window.document, [
        'div[role="textbox"][data-testid="tweetTextarea_0"]',
        'div[role="textbox"]',
      ]),
    ).toBe('div[role="textbox"][data-testid="tweetTextarea_0"]');
  });

  it('finds a generic Facebook file input fixture', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <input type="file" />
        </body>
      </html>
    `);

    expect(firstMatchingSelector(dom.window.document, ['input[type="file"]'])).toBe(
      'input[type="file"]',
    );
  });
});
