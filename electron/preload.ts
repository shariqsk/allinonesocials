import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels } from '../src/shared/ipc';
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
  SnapshotListener,
  ValidateAccountInput,
} from '../src/shared/types';

const api = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.getSnapshot) as Promise<AppSnapshot>,
  connectAccount: (input: ConnectAccountInput) =>
    ipcRenderer.invoke(ipcChannels.connectAccount, input) as Promise<ConnectAccountResult>,
  validateAccount: (input: ValidateAccountInput) =>
    ipcRenderer.invoke(ipcChannels.validateAccount, input) as Promise<ConnectAccountResult>,
  disconnectAccount: (input: DisconnectAccountInput) =>
    ipcRenderer.invoke(ipcChannels.disconnectAccount, input) as Promise<void>,
  saveDraft: (input: SaveDraftInput) =>
    ipcRenderer.invoke(ipcChannels.saveDraft, input) as Promise<SaveDraftResult>,
  publishNow: (input: PublishNowInput) =>
    ipcRenderer.invoke(ipcChannels.publishNow, input) as Promise<PublishNowResult>,
  schedulePost: (input: SchedulePostInput) =>
    ipcRenderer.invoke(ipcChannels.schedulePost, input) as Promise<SchedulePostResult>,
  subscribeToSnapshot: (listener: SnapshotListener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on(ipcChannels.snapshotUpdated, handler);

    return () => {
      ipcRenderer.removeListener(ipcChannels.snapshotUpdated, handler);
    };
  },
};

contextBridge.exposeInMainWorld('socialDesk', api);
