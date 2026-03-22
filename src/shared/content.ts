import type {
  ComposerInput,
  PlatformDefinitionMap,
  PlatformId,
  PlatformTargetState,
} from './types';

export const platformDefinitions: PlatformDefinitionMap = {
  x: {
    id: 'x',
    displayName: 'X',
    description: 'Short-form publishing with text, images, or a single video.',
    badge: 'X',
    textLimit: 280,
    minAssets: 0,
    maxAssets: 4,
    maxVideos: 1,
    allowMixedMedia: false,
    enabled: true,
  },
  facebook: {
    id: 'facebook',
    displayName: 'Facebook',
    description: 'Page and timeline style posting with images or a single video.',
    badge: 'F',
    textLimit: 63206,
    minAssets: 0,
    maxAssets: 10,
    maxVideos: 1,
    allowMixedMedia: false,
    enabled: true,
  },
  instagram: {
    id: 'instagram',
    displayName: 'Instagram',
    description: 'Feed-style publishing with images or a single video.',
    badge: 'I',
    textLimit: 2200,
    minAssets: 1,
    maxAssets: 10,
    maxVideos: 1,
    allowMixedMedia: false,
    enabled: true,
  },
  tiktok: {
    id: 'tiktok',
    displayName: 'TikTok',
    description: 'Video-only browser upload flow through TikTok web.',
    badge: 'T',
    textLimit: null,
    minAssets: 1,
    maxAssets: 0,
    maxVideos: 1,
    allowMixedMedia: false,
    enabled: true,
  },
};

export function uniquePlatforms(platforms: PlatformId[]) {
  return Array.from(new Set(platforms));
}

export function buildTargetStates(input: ComposerInput): PlatformTargetState[] {
  const textLength = input.body.trim().length;
  const assetCount = input.assets.length;
  const imageCount = input.assets.filter((asset) => asset.mediaKind === 'image').length;
  const videoCount = input.assets.filter((asset) => asset.mediaKind === 'video').length;

  return uniquePlatforms(input.selectedPlatforms).map((platform) => {
    const definition = platformDefinitions[platform];
    const reasons: string[] = [];

    if (!definition.enabled && definition.defaultBlockedReason) {
      reasons.push(definition.defaultBlockedReason);
    }

    if (definition.textLimit !== null && textLength > definition.textLimit) {
      reasons.push(
        `${definition.displayName} allows ${definition.textLimit} characters, current text is ${textLength}.`,
      );
    }

    if (assetCount < definition.minAssets) {
      reasons.push(
        `${definition.displayName} requires at least ${definition.minAssets} media file${definition.minAssets === 1 ? '' : 's'}.`,
      );
    }

    if (imageCount > definition.maxAssets) {
      reasons.push(
        `${definition.displayName} supports up to ${definition.maxAssets} image${definition.maxAssets === 1 ? '' : 's'}.`,
      );
    }

    if (videoCount > definition.maxVideos) {
      reasons.push(
        `${definition.displayName} supports up to ${definition.maxVideos} video${definition.maxVideos === 1 ? '' : 's'}.`,
      );
    }

    if (platform === 'tiktok' && videoCount === 0) {
      reasons.push('TikTok web posting in this app currently requires exactly one video.');
    }

    if (platform === 'tiktok' && imageCount > 0) {
      reasons.push('TikTok web posting in this app does not support image uploads yet.');
    }

    if (!definition.allowMixedMedia && imageCount > 0 && videoCount > 0) {
      reasons.push(`${definition.displayName} does not support mixing images and videos in this app yet.`);
    }

    return {
      platform,
      displayName: definition.displayName,
      enabled: reasons.length === 0,
      reason: reasons.length ? reasons.join(' ') : null,
      textLength,
      remainingCharacters:
        definition.textLimit === null ? null : definition.textLimit - textLength,
      assetCount,
      imageCount,
      videoCount,
    };
  });
}

export function validateComposer(input: ComposerInput) {
  const normalized = normalizeComposerInput(input);
  const targets = buildTargetStates(normalized);
  const blocking = targets.filter((target) => !target.enabled);

  if (!normalized.body.trim() && normalized.assets.length === 0) {
    return {
      valid: false,
      targets,
      message: 'Add text or at least one image or video before saving or posting.',
    };
  }

  if (normalized.selectedPlatforms.length === 0) {
    return {
      valid: false,
      targets,
      message: 'Select at least one platform.',
    };
  }

  if (blocking.length > 0) {
    return {
      valid: false,
      targets,
      message: blocking.map((target) => target.reason).join(' '),
    };
  }

  return {
    valid: true,
    targets,
    message: null,
  };
}

export function normalizeComposerInput(input: ComposerInput): ComposerInput {
  return {
    body: input.body.replace(/\r\n/g, '\n').trim(),
    assets: input.assets.filter((asset) => Boolean(asset.path)),
    selectedPlatforms: uniquePlatforms(input.selectedPlatforms),
  };
}
