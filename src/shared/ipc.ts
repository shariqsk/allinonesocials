export const ipcChannels = {
  getSnapshot: 'socialdesk:getSnapshot',
  connectAccount: 'socialdesk:connectAccount',
  validateAccount: 'socialdesk:validateAccount',
  disconnectAccount: 'socialdesk:disconnectAccount',
  selectAssets: 'socialdesk:selectAssets',
  saveDraft: 'socialdesk:saveDraft',
  publishNow: 'socialdesk:publishNow',
  schedulePost: 'socialdesk:schedulePost',
  snapshotUpdated: 'socialdesk:snapshotUpdated',
} as const;
