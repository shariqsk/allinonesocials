import { z } from 'zod';
import { platformIds } from './types';

export const platformIdSchema = z.enum(platformIds);

export const importedAssetSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  size: z.number().nonnegative(),
  mimeType: z.string().min(1),
});

export const composerInputSchema = z.object({
  body: z.string(),
  assets: z.array(importedAssetSchema),
  selectedPlatforms: z.array(platformIdSchema),
});

export const connectAccountInputSchema = z.object({
  platform: platformIdSchema,
});

export const validateAccountInputSchema = z.object({
  accountId: z.string().min(1),
});

export const disconnectAccountInputSchema = validateAccountInputSchema;

export const saveDraftInputSchema = composerInputSchema;

export const publishNowInputSchema = composerInputSchema;

export const schedulePostInputSchema = composerInputSchema.extend({
  scheduledFor: z.string().datetime(),
});
