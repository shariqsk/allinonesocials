export const platformIds = ['x', 'facebook', 'instagram', 'tiktok'] as const;

export type PlatformId = (typeof platformIds)[number];

export type AccountStatus = 'connected' | 'attention' | 'disconnected';
export type JobStatus =
  | 'pending'
  | 'running'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'partial'
  | 'missed';
export type PublishResultStatus = 'running' | 'success' | 'failed' | 'skipped';
export type MediaKind = 'image' | 'video';

export interface ImportedAsset {
  id: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  mediaKind: MediaKind;
}

export interface ComposerInput {
  body: string;
  assets: ImportedAsset[];
  selectedPlatforms: PlatformId[];
}

export interface DraftRecord extends ComposerInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformAccount {
  id: string;
  platform: PlatformId;
  label: string;
  status: AccountStatus;
  detail: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
}

export interface PlatformTargetState {
  platform: PlatformId;
  displayName: string;
  enabled: boolean;
  reason: string | null;
  textLength: number;
  remainingCharacters: number | null;
  assetCount: number;
  imageCount: number;
  videoCount: number;
}

export interface PlatformPublishResult {
  platform: PlatformId;
  status: PublishResultStatus;
  message: string;
  publishedAt: string | null;
  postUrl: string | null;
}

export interface PublishJob {
  id: string;
  draftId: string | null;
  payload: ComposerInput;
  scheduledFor: string | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  results: PlatformPublishResult[];
}

export interface PlatformDefinition {
  id: PlatformId;
  displayName: string;
  description: string;
  badge: string;
  textLimit: number | null;
  minAssets: number;
  maxAssets: number;
  maxVideos: number;
  allowMixedMedia: boolean;
  enabled: boolean;
  defaultBlockedReason?: string;
}

export type PlatformDefinitionMap = Record<PlatformId, PlatformDefinition>;

export interface DashboardStats {
  connectedAccounts: number;
  scheduledCount: number;
  publishedCount: number;
  failedCount: number;
}

export interface AppSnapshot {
  accounts: PlatformAccount[];
  drafts: DraftRecord[];
  scheduledJobs: PublishJob[];
  history: PublishJob[];
  platformDefinitions: PlatformDefinitionMap;
  stats: DashboardStats;
  lastUpdatedAt: string;
}

export interface ConnectAccountResult {
  account: PlatformAccount;
}

export interface PublishNowResult {
  job: PublishJob;
}

export interface SchedulePostResult {
  job: PublishJob;
}

export interface SaveDraftResult {
  draft: DraftRecord;
}

export interface SelectAssetsResult {
  assets: ImportedAsset[];
}

export interface ConnectAccountInput {
  platform: PlatformId;
}

export interface ValidateAccountInput {
  accountId: string;
}

export interface DisconnectAccountInput {
  accountId: string;
}

export interface CancelJobInput {
  jobId: string;
}

export interface SaveDraftInput extends ComposerInput {}

export interface PublishNowInput extends ComposerInput {}

export interface SchedulePostInput extends ComposerInput {
  scheduledFor: string;
}

export type SnapshotListener = (snapshot: AppSnapshot) => void;
