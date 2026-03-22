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
  it('blocks Instagram when no media is attached', () => {
    const targets = buildTargetStates({
      body: 'Caption only',
      assets: [],
      selectedPlatforms: ['instagram'],
    });

    expect(targets[0]?.enabled).toBe(false);
    expect(targets[0]?.reason).toContain('requires at least 1 media');
  });

  it('blocks mixed media on X', () => {
    const targets = buildTargetStates({
      body: 'Mixed upload',
      assets: [
        {
          id: 'asset-1',
          path: '/tmp/pic.png',
          name: 'pic.png',
          size: 100,
          mimeType: 'image/png',
          mediaKind: 'image',
        },
        {
          id: 'asset-2',
          path: '/tmp/clip.mp4',
          name: 'clip.mp4',
          size: 200,
          mimeType: 'video/mp4',
          mediaKind: 'video',
        },
      ],
      selectedPlatforms: ['x'],
    });

    expect(targets[0]?.enabled).toBe(false);
    expect(targets[0]?.reason).toContain('does not support mixing images and videos');
  });
});

describe('validateComposer', () => {
  it('rejects image-only posts on TikTok', () => {
    const result = validateComposer({
      body: 'Launching soon',
      assets: [
        {
          id: 'asset-1',
          path: '/tmp/launch.png',
          name: 'launch.png',
          size: 1234,
          mimeType: 'image/png',
          mediaKind: 'image',
        },
      ],
      selectedPlatforms: ['tiktok'],
    });

    expect(result.valid).toBe(false);
    expect(result.message).toContain('requires exactly one video');
  });

  it('allows a single TikTok video', () => {
    const result = validateComposer({
      body: 'Launching soon',
      assets: [
        {
          id: 'asset-1',
          path: '/tmp/launch.mp4',
          name: 'launch.mp4',
          size: 1234,
          mimeType: 'video/mp4',
          mediaKind: 'video',
        },
      ],
      selectedPlatforms: ['tiktok'],
    });

    expect(result.valid).toBe(true);
  });
});
