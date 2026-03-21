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
    description: 'Short-form publishing with live text and image posting.',
    badge: 'X',
    textLimit: 280,
    minAssets: 0,
    maxAssets: 4,
    enabled: true,
  },
  facebook: {
    id: 'facebook',
    displayName: 'Facebook',
    description: 'Page and timeline style posting with flexible copy length.',
    badge: 'F',
    textLimit: 63206,
    minAssets: 0,
    maxAssets: 10,
    enabled: true,
  },
  instagram: {
    id: 'instagram',
    displayName: 'Instagram',
    description: 'Image-first publishing. Feed posts require at least one asset.',
    badge: 'I',
    textLimit: 2200,
    minAssets: 1,
    maxAssets: 10,
    enabled: true,
  },
  tiktok: {
    id: 'tiktok',
    displayName: 'TikTok',
    description: 'Scaffolded only in v1. Cross-post publishing is intentionally blocked.',
    badge: 'T',
    textLimit: null,
    minAssets: 1,
    maxAssets: 1,
    enabled: false,
    defaultBlockedReason: 'TikTok is scaffolded but excluded from the unified v1 publish flow.',
  },
};

export function uniquePlatforms(platforms: PlatformId[]) {
  return Array.from(new Set(platforms));
}

export function buildTargetStates(input: ComposerInput): PlatformTargetState[] {
  const textLength = input.body.trim().length;
  const assetCount = input.assets.length;

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
        `${definition.displayName} requires at least ${definition.minAssets} image${definition.minAssets === 1 ? '' : 's'}.`,
      );
    }

    if (assetCount > definition.maxAssets) {
      reasons.push(
        `${definition.displayName} supports up to ${definition.maxAssets} image${definition.maxAssets === 1 ? '' : 's'}.`,
      );
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
      message: 'Add text or at least one image before saving or posting.',
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
