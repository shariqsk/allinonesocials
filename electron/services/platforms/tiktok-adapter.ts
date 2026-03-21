import { BaseAdapter, type ConnectOptions, type PublishOptions, type SessionSummary } from './base';

export class TikTokAdapter extends BaseAdapter {
  readonly platform = 'tiktok' as const;

  protected readonly loginUrl = 'https://www.tiktok.com/login';

  protected readonly homeUrl = 'https://www.tiktok.com/';

  async connect(_options: ConnectOptions): Promise<SessionSummary> {
    return {
      label: 'TikTok placeholder',
      detail: 'TikTok is scaffolded only and not connectable in the unified v1 flow.',
      status: 'attention',
      lastKnownUrl: null,
    };
  }

  async validateSession(_secret: PublishOptions['secret']): Promise<SessionSummary> {
    return {
      label: 'TikTok placeholder',
      detail: 'TikTok validation is not implemented in the v1 unified flow.',
      status: 'attention',
      lastKnownUrl: null,
    };
  }

  async publish(_options: PublishOptions) {
    return this.buildFailure(this.platform, 'TikTok publishing is intentionally disabled in v1.');
  }
}
