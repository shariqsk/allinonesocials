import { describe, expect, it } from 'vitest';
import { buildTargetStates, normalizeComposerInput, validateComposer } from './content';

describe('normalizeComposerInput', () => {
  it('deduplicates platforms and trims body text', () => {
    const normalized = normalizeComposerInput({
      body: ' Hello world \n',
      assets: [],
      selectedPlatforms: ['x', 'x', 'facebook'],
    });

    expect(normalized.body).toBe('Hello world');
    expect(normalized.selectedPlatforms).toEqual(['x', 'facebook']);
  });
});

describe('buildTargetStates', () => {
  it('blocks Instagram when no images are attached', () => {
    const targets = buildTargetStates({
      body: 'Caption only',
      assets: [],
      selectedPlatforms: ['instagram'],
    });

    expect(targets[0]?.enabled).toBe(false);
    expect(targets[0]?.reason).toContain('requires at least 1 image');
  });
});

describe('validateComposer', () => {
  it('rejects tiktok from the unified v1 flow', () => {
    const result = validateComposer({
      body: 'Launching soon',
      assets: [
        {
          id: 'asset-1',
          path: '/tmp/launch.png',
          name: 'launch.png',
          size: 1234,
          mimeType: 'image/png',
        },
      ],
      selectedPlatforms: ['tiktok'],
    });

    expect(result.valid).toBe(false);
    expect(result.message).toContain('TikTok is scaffolded');
  });
});
