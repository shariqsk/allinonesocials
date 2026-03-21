import type { PlatformId } from '../../src/shared/types';
import { FacebookAdapter } from './platforms/facebook-adapter';
import type { PlatformAdapter } from './platforms/base';
import { InstagramAdapter } from './platforms/instagram-adapter';
import { TikTokAdapter } from './platforms/tiktok-adapter';
import { XAdapter } from './platforms/x-adapter';

export class PlatformRegistry {
  private readonly adapters: Record<PlatformId, PlatformAdapter> = {
    x: new XAdapter(),
    facebook: new FacebookAdapter(),
    instagram: new InstagramAdapter(),
    tiktok: new TikTokAdapter(),
  };

  get(platform: PlatformId) {
    return this.adapters[platform];
  }
}
