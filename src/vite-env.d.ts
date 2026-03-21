/// <reference types="vite/client" />

import type {
  AppSnapshot,
  ConnectAccountInput,
  ConnectAccountResult,
  DisconnectAccountInput,
  PublishNowInput,
  PublishNowResult,
  SaveDraftInput,
  SaveDraftResult,
  SchedulePostInput,
  SchedulePostResult,
  SelectAssetsResult,
  SnapshotListener,
  ValidateAccountInput,
} from './shared/types';

declare global {
  interface Window {
    socialDesk: {
      getSnapshot: () => Promise<AppSnapshot>;
      connectAccount: (input: ConnectAccountInput) => Promise<ConnectAccountResult>;
      validateAccount: (input: ValidateAccountInput) => Promise<ConnectAccountResult>;
      disconnectAccount: (input: DisconnectAccountInput) => Promise<void>;
      selectAssets: () => Promise<SelectAssetsResult>;
      saveDraft: (input: SaveDraftInput) => Promise<SaveDraftResult>;
      publishNow: (input: PublishNowInput) => Promise<PublishNowResult>;
      schedulePost: (input: SchedulePostInput) => Promise<SchedulePostResult>;
      subscribeToSnapshot: (listener: SnapshotListener) => () => void;
    };
  }
}

export {};
