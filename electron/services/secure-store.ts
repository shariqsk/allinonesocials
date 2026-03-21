import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { PlatformId } from '../../src/shared/types';

export interface AccountSecret {
  accountId: string;
  platform: PlatformId;
  profileDir: string;
  lastKnownUrl: string | null;
}

export class SecureStore {
  private readonly filePath: string;

  private cache: Record<string, AccountSecret> = {};

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'secure-store.json');
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const raw = await readFile(this.filePath).catch(() => null);
    if (!raw) {
      this.cache = {};
      return;
    }

    const decrypted = this.decrypt(raw);
    this.cache = JSON.parse(decrypted) as Record<string, AccountSecret>;
  }

  getAccountSecret(accountId: string) {
    return this.cache[accountId] ?? null;
  }

  async setAccountSecret(secret: AccountSecret) {
    this.cache[secret.accountId] = secret;
    await this.persist();
  }

  async removeAccountSecret(accountId: string) {
    delete this.cache[accountId];
    await this.persist();
  }

  private async persist() {
    const payload = Buffer.from(JSON.stringify(this.cache, null, 2), 'utf8');
    await writeFile(this.filePath, this.encrypt(payload));
  }

  private encrypt(payload: Buffer) {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(payload.toString('utf8'));
    }

    return Buffer.from(payload.toString('base64'), 'utf8');
  }

  private decrypt(payload: Buffer) {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(payload);
    }

    return Buffer.from(payload.toString('utf8'), 'base64').toString('utf8');
  }
}
