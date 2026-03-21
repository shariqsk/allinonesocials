import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import log from 'electron-log/main';
import { platformDefinitions } from '../src/shared/content';
import { ipcChannels } from '../src/shared/ipc';
import {
  connectAccountInputSchema,
  disconnectAccountInputSchema,
  publishNowInputSchema,
  saveDraftInputSchema,
  schedulePostInputSchema,
  validateAccountInputSchema,
} from '../src/shared/schemas';
import { DatabaseService } from './services/database';
import { SchedulerService } from './services/scheduler';
import { SecureStore } from './services/secure-store';
import { SocialManager } from './services/social-manager';

log.initialize();
log.errorHandler.startCatching();

let mainWindow: BrowserWindow | null = null;

async function bootstrap() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  const secureDir = path.join(app.getPath('userData'), 'secure');
  const profilesDir = path.join(app.getPath('userData'), 'profiles');

  const database = new DatabaseService(dataDir, platformDefinitions);
  const secureStore = new SecureStore(secureDir);

  await database.initialize();
  await secureStore.initialize();

  const manager = new SocialManager({
    database,
    secureStore,
    profilesDir,
    onSnapshot: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(ipcChannels.snapshotUpdated, manager.getSnapshot());
      }
    },
  });

  const scheduler = new SchedulerService(database, (jobId) => manager.executeJob(jobId), () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ipcChannels.snapshotUpdated, manager.getSnapshot());
    }
  });

  await scheduler.start();
  registerIpc(manager);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f3efe6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function registerIpc(manager: SocialManager) {
  ipcMain.handle(ipcChannels.getSnapshot, async () => manager.getSnapshot());
  ipcMain.handle(ipcChannels.connectAccount, async (_event, payload) =>
    manager.connectAccount(connectAccountInputSchema.parse(payload)),
  );
  ipcMain.handle(ipcChannels.validateAccount, async (_event, payload) =>
    manager.validateAccount(validateAccountInputSchema.parse(payload)),
  );
  ipcMain.handle(ipcChannels.disconnectAccount, async (_event, payload) =>
    manager.disconnectAccount(disconnectAccountInputSchema.parse(payload)),
  );
  ipcMain.handle(ipcChannels.saveDraft, async (_event, payload) =>
    manager.saveDraft(saveDraftInputSchema.parse(payload)),
  );
  ipcMain.handle(ipcChannels.publishNow, async (_event, payload) =>
    manager.publishNow(publishNowInputSchema.parse(payload)),
  );
  ipcMain.handle(ipcChannels.schedulePost, async (_event, payload) =>
    manager.schedulePost(schedulePostInputSchema.parse(payload)),
  );
}

app.whenReady()
  .then(async () => {
    await bootstrap();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  })
  .catch((error) => {
    log.error('Failed to bootstrap Social Desk', error);
    app.quit();
  });

process.on('unhandledRejection', (error) => {
  log.error('Unhandled promise rejection in main process', error);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
