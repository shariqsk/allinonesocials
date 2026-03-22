import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { buildTargetStates, platformDefinitions, validateComposer } from './shared/content';
import type {
  AppSnapshot,
  ComposerInput,
  ImportedAsset,
  AccountStatus,
  PlatformAccount,
  PlatformId,
  PublishJob,
} from './shared/types';

type View = 'dashboard' | 'accounts' | 'composer' | 'scheduled' | 'history' | 'settings';
type PublishMode = 'now' | 'schedule';

const navigation: { id: View; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'composer', label: 'Composer' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

const defaultSnapshot: AppSnapshot = {
  accounts: [],
  drafts: [],
  scheduledJobs: [],
  history: [],
  platformDefinitions,
  stats: {
    connectedAccounts: 0,
    scheduledCount: 0,
    publishedCount: 0,
    failedCount: 0,
  },
  lastUpdatedAt: new Date(0).toISOString(),
};

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [snapshot, setSnapshot] = useState<AppSnapshot>(defaultSnapshot);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [assets, setAssets] = useState<ImportedAsset[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<PlatformId[]>(['x', 'facebook', 'instagram']);
  const [publishMode, setPublishMode] = useState<PublishMode>('now');
  const [scheduledFor, setScheduledFor] = useState(dayjs().add(1, 'hour').format('YYYY-MM-DDTHH:mm'));
  const [postingStep, setPostingStep] = useState(0);

  useEffect(() => {
    void loadSnapshot();

    const unsubscribe = window.socialDesk.subscribeToSnapshot((nextSnapshot: AppSnapshot) => {
      setSnapshot(nextSnapshot);
    });

    return unsubscribe;
  }, []);

  const composerInput: ComposerInput = useMemo(
    () => ({
      body,
      assets,
      selectedPlatforms,
    }),
    [assets, body, selectedPlatforms],
  );

  const validation = useMemo(() => validateComposer(composerInput), [composerInput]);
  const targetStates = useMemo(() => buildTargetStates(composerInput), [composerInput]);
  const primaryAccounts = useMemo(() => buildPrimaryAccounts(snapshot.accounts), [snapshot.accounts]);
  const connectedPlatformIds = useMemo(
    () =>
      (Object.entries(primaryAccounts) as Array<[PlatformId, PlatformAccount | undefined]>)
        .filter(([, account]) => account?.status === 'connected')
        .map(([platform]) => platform),
    [primaryAccounts],
  );

  useEffect(() => {
    const allowed = connectedPlatformIds.filter((platform) => platformDefinitions[platform].enabled);
    setSelectedPlatforms((current) => {
      const next = current.filter((platform) => allowed.includes(platform));
      if (next.length > 0) {
        return next;
      }
      return allowed;
    });
  }, [connectedPlatformIds]);

  const isPublishing = busy === 'Publishing post';

  useEffect(() => {
    if (!isPublishing) {
      setPostingStep(0);
      return;
    }

    const timer = window.setInterval(() => {
      setPostingStep((current) => (current + 1) % postingSteps.length);
    }, 1200);

    return () => {
      window.clearInterval(timer);
    };
  }, [isPublishing]);

  async function loadSnapshot() {
    setLoading(true);
    try {
      const nextSnapshot = await window.socialDesk.getSnapshot();
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  }

  async function runAction(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setSuccess(null);

    try {
      await action();
      await loadSnapshot();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setBusy(null);
    }
  }

  function togglePlatform(platform: PlatformId) {
    setSelectedPlatforms((current) =>
      current.includes(platform)
        ? current.filter((value) => value !== platform)
        : [...current, platform],
    );
  }

  async function openAssetPicker() {
    await runAction('Selecting media', async () => {
      const result = await window.socialDesk.selectAssets();
      if (result.assets.length > 0) {
        setAssets(result.assets);
        const imageCount = result.assets.filter((asset) => asset.mediaKind === 'image').length;
        const videoCount = result.assets.filter((asset) => asset.mediaKind === 'video').length;
        setSuccess(buildMediaSelectionMessage(imageCount, videoCount));
      }
    });
  }

  function removeAsset(assetId: string) {
    setAssets((current) => current.filter((asset) => asset.id !== assetId));
  }

  function resetComposer() {
    setBody('');
    setAssets([]);
    setSelectedPlatforms(['x', 'facebook', 'instagram']);
    setPublishMode('now');
    setScheduledFor(dayjs().add(1, 'hour').format('YYYY-MM-DDTHH:mm'));
  }

  async function connectPlatform(platform: PlatformId) {
    await runAction(`Connecting ${platform}`, async () => {
      const result = await window.socialDesk.connectAccount({ platform });
      setSuccess(`${result.account.label} connected.`);
    });
  }

  async function validateAccount(accountId: string) {
    await runAction('Validating account', async () => {
      const result = await window.socialDesk.validateAccount({ accountId });
      setSuccess(`${result.account.label} checked.`);
    });
  }

  async function disconnectAccount(accountId: string) {
    await runAction('Disconnecting account', async () => {
      await window.socialDesk.disconnectAccount({ accountId });
      setSuccess('Account disconnected.');
    });
  }

  async function saveDraft() {
    await runAction('Saving draft', async () => {
      const result = await window.socialDesk.saveDraft(composerInput);
      setSuccess(`Draft ${result.draft.id.slice(-6)} saved.`);
    });
  }

  async function publishNow() {
    await runAction('Publishing post', async () => {
      const result = await window.socialDesk.publishNow(composerInput);
      setSuccess(`Publish finished with ${result.job.status} status.`);
      setView('history');
      resetComposer();
    });
  }

  async function schedulePost() {
    await runAction('Scheduling post', async () => {
      const result = await window.socialDesk.schedulePost({
        ...composerInput,
        scheduledFor: dayjs(scheduledFor).toISOString(),
      });
      setSuccess(`Job ${result.job.id.slice(-6)} scheduled.`);
      setView('scheduled');
      resetComposer();
    });
  }

  return (
    <div className="app-shell">
      {isPublishing ? (
        <PostingOverlay
          step={postingSteps[postingStep]}
          selectedPlatforms={selectedPlatforms}
          assets={assets}
        />
      ) : null}
      <aside className="sidebar">
        <div className="brand-block">
          <span className="brand-mark">SD</span>
          <div>
            <p className="eyebrow">Local-first publishing</p>
            <h1>Social Desk</h1>
          </div>
        </div>

        <nav className="nav-list">
          {navigation.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? 'nav-button nav-button-active' : 'nav-button'}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <section className="sidebar-panel">
          <h2>Local mode</h2>
          <p>
            Sessions, drafts, schedules, and publish history stay on this machine. Keep
            the app open for scheduled posts.
          </p>
        </section>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Cross-post manager</p>
            <h2>{navigation.find((item) => item.id === view)?.label}</h2>
          </div>
          <div className="topbar-meta">
            <span>Updated {formatTimestamp(snapshot.lastUpdatedAt)}</span>
            <button type="button" className="ghost-button" onClick={() => void loadSnapshot()}>
              Refresh
            </button>
          </div>
        </header>

        {error ? <div className="notice notice-error">{error}</div> : null}
        {success ? <div className="notice notice-success">{success}</div> : null}
        {busy ? <div className="notice notice-busy">{busy}…</div> : null}
        {loading ? <div className="notice">Loading your local workspace…</div> : null}

        {view === 'dashboard' ? <DashboardView snapshot={snapshot} /> : null}
        {view === 'accounts' ? (
          <AccountsView
            accounts={primaryAccounts}
            onConnect={connectPlatform}
            onValidate={validateAccount}
            onDisconnect={disconnectAccount}
          />
        ) : null}
        {view === 'composer' ? (
          <ComposerView
            body={body}
            assets={assets}
            selectedPlatforms={selectedPlatforms}
            connectedPlatforms={connectedPlatformIds}
            accountStatuses={buildAccountStatuses(primaryAccounts)}
            publishMode={publishMode}
            scheduledFor={scheduledFor}
            targetStates={targetStates}
            validationMessage={validation.message}
            onBodyChange={setBody}
            onSelectAssets={() => void openAssetPicker()}
            onRemoveAsset={removeAsset}
            onTogglePlatform={togglePlatform}
            onPublishModeChange={setPublishMode}
            onScheduledForChange={setScheduledFor}
            onSaveDraft={() => void saveDraft()}
            onPublishNow={() => void publishNow()}
            onSchedulePost={() => void schedulePost()}
          />
        ) : null}
        {view === 'scheduled' ? <ScheduledView jobs={snapshot.scheduledJobs} /> : null}
        {view === 'history' ? <HistoryView jobs={snapshot.history} /> : null}
        {view === 'settings' ? <SettingsView /> : null}
      </main>
    </div>
  );
}

function DashboardView({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <section className="view-grid">
      <div className="stat-card">
        <p className="eyebrow">Accounts</p>
        <strong>{snapshot.stats.connectedAccounts}</strong>
        <span>connected sessions</span>
      </div>
      <div className="stat-card">
        <p className="eyebrow">Scheduled</p>
        <strong>{snapshot.stats.scheduledCount}</strong>
        <span>jobs waiting while the app stays open</span>
      </div>
      <div className="stat-card">
        <p className="eyebrow">Published</p>
        <strong>{snapshot.stats.publishedCount}</strong>
        <span>completed jobs</span>
      </div>
      <div className="stat-card">
        <p className="eyebrow">Attention</p>
        <strong>{snapshot.stats.failedCount}</strong>
        <span>failed or partial jobs</span>
      </div>

      <div className="panel panel-wide">
        <div className="panel-header">
          <h3>Connected Platforms</h3>
          <span>{snapshot.accounts.length} configured</span>
        </div>
        <div className="platform-overview">
          {Object.values(snapshot.platformDefinitions).map((platform) => {
            const connected = snapshot.accounts.filter(
              (account) => account.platform === platform.id && account.status === 'connected',
            ).length;
            return (
              <article className="platform-chip" key={platform.id}>
                <span>{platform.badge}</span>
                <div>
                  <strong>{platform.displayName}</strong>
                  <p>{connected > 0 ? `${connected} active session(s)` : platform.description}</p>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div className="panel panel-wide">
        <div className="panel-header">
          <h3>Recent Activity</h3>
          <span>{snapshot.history.length} total jobs</span>
        </div>
        <div className="table-list">
          {snapshot.history.slice(0, 6).map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
          {snapshot.history.length === 0 ? <EmptyState text="No publish history yet." /> : null}
        </div>
      </div>
    </section>
  );
}

function PostingOverlay({
  step,
  selectedPlatforms,
  assets,
}: {
  step: string;
  selectedPlatforms: PlatformId[];
  assets: ImportedAsset[];
}) {
  const imageCount = assets.filter((asset) => asset.mediaKind === 'image').length;
  const videoCount = assets.filter((asset) => asset.mediaKind === 'video').length;

  return (
    <div className="posting-overlay">
      <div className="posting-card">
        <div className="posting-spinner" aria-hidden="true">
          <span className="posting-ring posting-ring-one" />
          <span className="posting-ring posting-ring-two" />
          <span className="posting-core" />
        </div>
        <p className="eyebrow">Publishing</p>
        <h2>Sending your post out now</h2>
        <p className="posting-step">{step}</p>
        <div className="posting-track">
          <span className="posting-bar" />
        </div>
        <div className="posting-meta">
          <span>{selectedPlatforms.map((platform) => platformDefinitions[platform].displayName).join(' · ')}</span>
          <span>{buildMediaSelectionMessage(imageCount, videoCount).replace(' selected.', '')}</span>
        </div>
      </div>
    </div>
  );
}

function AccountsView({
  accounts,
  onConnect,
  onValidate,
  onDisconnect,
}: {
  accounts: Record<PlatformId, PlatformAccount | undefined>;
  onConnect: (platform: PlatformId) => void;
  onValidate: (accountId: string) => void;
  onDisconnect: (accountId: string) => void;
}) {
  return (
    <section className="stacked-layout">
      <div className="panel">
        <div className="panel-header">
          <h3>Connection Workflow</h3>
          <span>Uses Playwright-managed browser sessions</span>
        </div>
        <p className="muted-copy">
          Connecting an account opens a real browser window. Sign in normally, complete any
          MFA or checkpoints, and the app stores that session locally for later publishing.
        </p>
      </div>

      <div className="account-grid">
        {Object.values(platformDefinitions).map((platform) => {
          const account = accounts[platform.id];
          const isConnected = account?.status === 'connected';
          const canConnect = platform.enabled && !isConnected;
          return (
            <article className="panel" key={platform.id}>
              <div className="panel-header">
                <div>
                  <p className="eyebrow">{platform.badge}</p>
                  <h3>{platform.displayName}</h3>
                </div>
                <div className="row-actions">
                  {account ? <StatusPill status={account.status} /> : null}
                  {!platform.enabled ? (
                    <button type="button" className="ghost-button" disabled>
                      Scaffolded only
                    </button>
                  ) : canConnect ? (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => onConnect(platform.id)}
                    >
                      Connect account
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onConnect(platform.id)}
                    >
                      Reconnect
                    </button>
                  )}
                </div>
              </div>
              <p className="muted-copy">{platform.description}</p>
              <div className="table-list">
                {account ? (
                  <div className="row-card" key={account.id}>
                    <div>
                      <strong>{account.label}</strong>
                      <p>{account.detail}</p>
                    </div>
                    <div className="row-actions">
                      <button type="button" className="ghost-button" onClick={() => onValidate(account.id)}>
                        Check
                      </button>
                      <button
                        type="button"
                        className="ghost-button ghost-button-danger"
                        onClick={() => onDisconnect(account.id)}
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                ) : (
                  <EmptyState text={`No ${platform.displayName} accounts connected yet.`} />
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

interface ComposerViewProps {
  body: string;
  assets: ImportedAsset[];
  selectedPlatforms: PlatformId[];
  connectedPlatforms: PlatformId[];
  accountStatuses: Record<PlatformId, AccountStatus>;
  publishMode: PublishMode;
  scheduledFor: string;
  targetStates: ReturnType<typeof buildTargetStates>;
  validationMessage: string | null;
  onBodyChange: (value: string) => void;
  onSelectAssets: () => void;
  onRemoveAsset: (assetId: string) => void;
  onTogglePlatform: (platform: PlatformId) => void;
  onPublishModeChange: (mode: PublishMode) => void;
  onScheduledForChange: (value: string) => void;
  onSaveDraft: () => void;
  onPublishNow: () => void;
  onSchedulePost: () => void;
}

function ComposerView(props: ComposerViewProps) {
  const {
    body,
    assets,
    selectedPlatforms,
    connectedPlatforms,
    accountStatuses,
    publishMode,
    scheduledFor,
    targetStates,
    validationMessage,
    onBodyChange,
    onSelectAssets,
    onRemoveAsset,
    onTogglePlatform,
    onPublishModeChange,
    onScheduledForChange,
    onSaveDraft,
    onPublishNow,
    onSchedulePost,
  } = props;

  return (
    <section className="composer-layout">
      <div className="panel composer-panel">
        <div className="panel-header">
          <h3>Write Once</h3>
          <span>Text, images, or a single video</span>
        </div>

        <div className="composer-mode-row">
          <button
            type="button"
            className={publishMode === 'now' ? 'mode-button mode-button-active' : 'mode-button'}
            onClick={() => onPublishModeChange('now')}
          >
            Post now
          </button>
          <button
            type="button"
            className={publishMode === 'schedule' ? 'mode-button mode-button-active' : 'mode-button'}
            onClick={() => onPublishModeChange('schedule')}
          >
            Schedule
          </button>
        </div>

        <div className="inline-note">
          {publishMode === 'now'
            ? 'Post immediately to the selected platforms.'
            : 'Queue this post for later while the app stays open.'}
        </div>

        <label className="field-block">
          <span>Post text</span>
          <textarea
            value={body}
            onChange={(event) => onBodyChange(event.target.value)}
            placeholder="Draft the message once, then let each platform preview adapt around it."
          />
        </label>

        <label className="field-block">
          <span>Images</span>
          <div className="asset-picker-row">
            <button type="button" className="ghost-button" onClick={onSelectAssets}>
              Choose media
            </button>
            <span className="muted-copy">
              Uses the native file picker so local file paths persist correctly.
            </span>
          </div>
        </label>

        <div className="asset-list">
          {assets.map((asset) => (
            <div className="asset-chip" key={asset.id}>
              <div>
                <strong>{asset.name}</strong>
                <span>
                  {asset.mediaKind === 'video' ? 'Video' : 'Image'} · {Math.round(asset.size / 1024)} KB
                </span>
              </div>
              <button
                type="button"
                className="ghost-button ghost-button-tight"
                onClick={() => onRemoveAsset(asset.id)}
              >
                Remove
              </button>
            </div>
          ))}
          {assets.length === 0 ? <EmptyState text="No media added yet." compact /> : null}
        </div>

        <div className="platform-selector">
          {Object.values(platformDefinitions).map((platform) => (
            <label className="platform-toggle" key={platform.id}>
              <input
                type="checkbox"
                checked={selectedPlatforms.includes(platform.id)}
                onChange={() => onTogglePlatform(platform.id)}
                disabled={!connectedPlatforms.includes(platform.id)}
              />
              <span>{platform.displayName}</span>
            </label>
          ))}
        </div>
        {connectedPlatforms.length === 0 ? (
          <div className="notice notice-error">
            Connect at least one platform in Accounts before posting from the composer.
          </div>
        ) : null}

        {publishMode === 'schedule' ? (
          <div className="field-row">
            <label className="field-block">
              <span>Schedule for</span>
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(event) => onScheduledForChange(event.target.value)}
              />
            </label>
          </div>
        ) : null}

        {validationMessage ? <div className="notice notice-error">{validationMessage}</div> : null}

        <div className="action-row">
          <button type="button" className="ghost-button" onClick={onSaveDraft}>
            Save draft
          </button>
          {publishMode === 'schedule' ? (
            <button type="button" className="primary-button" onClick={onSchedulePost}>
              Schedule post
            </button>
          ) : (
            <button type="button" className="primary-button" onClick={onPublishNow}>
              Post now
            </button>
          )}
        </div>
      </div>

      <div className="panel preview-panel">
        <div className="panel-header">
          <h3>Per-Platform Preview</h3>
          <span>Validation happens before publish</span>
        </div>

        <div className="preview-list">
          {targetStates.map((target) => (
            <article className="preview-card" key={target.platform}>
              <div className="panel-header">
                <div>
                  <p className="eyebrow">{platformDefinitions[target.platform].badge}</p>
                  <h3>{target.displayName}</h3>
                </div>
                <StatusPill
                  status={
                    accountStatuses[target.platform] === 'connected'
                      ? target.enabled
                        ? 'connected'
                        : 'attention'
                      : accountStatuses[target.platform]
                  }
                  label={
                    accountStatuses[target.platform] === 'connected'
                      ? target.enabled
                        ? 'ready'
                        : 'needs changes'
                      : accountStatuses[target.platform]
                  }
                />
              </div>
              <p>{body || 'Your draft text will preview here.'}</p>
              <div className="meta-grid">
                <span>{target.assetCount} images</span>
                <span>{target.videoCount > 0 ? `${target.videoCount} video` : `${target.imageCount} images`}</span>
                <span>
                  {target.remainingCharacters === null
                    ? 'No shared limit'
                    : `${target.remainingCharacters} chars left`}
                </span>
              </div>
              <div
                className={
                  accountStatuses[target.platform] === 'connected' && target.enabled
                    ? 'inline-note'
                    : 'inline-note inline-note-error'
                }
              >
                {accountStatuses[target.platform] !== 'connected'
                  ? 'No validated account is connected for this platform.'
                  : target.reason ?? 'Ready to publish.'}
              </div>
            </article>
          ))}
          {targetStates.length === 0 ? <EmptyState text="Select one or more platforms to preview." /> : null}
        </div>
      </div>
    </section>
  );
}

function ScheduledView({ jobs }: { jobs: PublishJob[] }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Scheduled Jobs</h3>
        <span>These only run while the app is open</span>
      </div>
      <div className="table-list">
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
        {jobs.length === 0 ? <EmptyState text="No scheduled jobs yet." /> : null}
      </div>
    </section>
  );
}

function HistoryView({ jobs }: { jobs: PublishJob[] }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Publish History</h3>
        <span>Partial success is tracked per platform</span>
      </div>
      <div className="table-list">
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
        {jobs.length === 0 ? <EmptyState text="No publish history yet." /> : null}
      </div>
    </section>
  );
}

function SettingsView() {
  return (
    <section className="stacked-layout">
      <div className="panel">
        <div className="panel-header">
          <h3>Runtime Notes</h3>
          <span>Local-first only</span>
        </div>
        <ul className="settings-list">
          <li>All account sessions are stored on this machine in Playwright profile directories.</li>
          <li>Secure metadata is encrypted through Electron safe storage when available.</li>
          <li>There is no cloud backend, API key setup, or `.env` requirement for normal use.</li>
          <li>Scheduled jobs are marked missed if the app is closed when they were due.</li>
        </ul>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Platform Scope</h3>
          <span>V1 boundaries</span>
        </div>
        <ul className="settings-list">
          <li>X, Facebook, and Instagram are in the active publish flow.</li>
          <li>TikTok is intentionally scaffolded only and blocked from the shared v1 composer.</li>
          <li>Browser automation remains isolated inside per-platform adapters so future maintenance stays contained.</li>
        </ul>
      </div>
    </section>
  );
}

function JobRow({ job }: { job: PublishJob }) {
  return (
    <article className="row-card">
      <div>
        <div className="row-heading">
          <strong>{job.payload.selectedPlatforms.join(', ')}</strong>
          <StatusPill status={job.status === 'completed' ? 'connected' : job.status === 'pending' ? 'disconnected' : 'attention'} label={job.status} />
        </div>
        <p>{job.payload.body || `${job.payload.assets.length} image(s)`}</p>
        <div className="meta-grid">
          <span>Created {formatTimestamp(job.createdAt)}</span>
          <span>{job.scheduledFor ? `Scheduled ${formatTimestamp(job.scheduledFor)}` : 'Published immediately'}</span>
        </div>
      </div>
      <div className="result-list">
        {job.results.map((result) => (
          <div className="result-detail" key={`${job.id}-${result.platform}`}>
            <span
              className={
                result.status === 'success'
                  ? 'result-pill result-pill-success'
                  : result.status === 'failed'
                    ? 'result-pill result-pill-error'
                    : 'result-pill'
              }
            >
              {platformDefinitions[result.platform].displayName}: {result.status}
            </span>
            <span className="result-message">{result.message}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function StatusPill({
  status,
  label,
}: {
  status: 'connected' | 'attention' | 'disconnected';
  label?: string;
}) {
  return (
    <span className={`status-pill status-${status}`}>
      {label ?? status}
    </span>
  );
}

function EmptyState({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={compact ? 'empty-state empty-state-compact' : 'empty-state'}>{text}</div>;
}

function formatTimestamp(value: string) {
  return dayjs(value).format('MMM D, YYYY h:mm A');
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'An unexpected error occurred.';
}

function buildMediaSelectionMessage(imageCount: number, videoCount: number) {
  const parts: string[] = [];
  if (imageCount > 0) {
    parts.push(`${imageCount} image${imageCount === 1 ? '' : 's'}`);
  }
  if (videoCount > 0) {
    parts.push(`${videoCount} video${videoCount === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) {
    return 'Text only';
  }
  return `${parts.join(' and ')} selected.`;
}

const postingSteps = [
  'Preparing browser sessions',
  'Uploading media',
  'Finalizing post requests',
];

function buildPrimaryAccounts(accounts: PlatformAccount[]) {
  const result: Record<PlatformId, PlatformAccount | undefined> = {
    x: undefined,
    facebook: undefined,
    instagram: undefined,
    tiktok: undefined,
  };

  for (const platform of Object.keys(result) as PlatformId[]) {
    const candidates = accounts.filter((account) => account.platform === platform);
    result[platform] =
      candidates.find((account) => account.status === 'connected') ??
      candidates.find((account) => account.status === 'attention') ??
      candidates[0];
  }

  return result;
}

function buildAccountStatuses(accounts: Record<PlatformId, PlatformAccount | undefined>) {
  return {
    x: accounts.x?.status ?? 'disconnected',
    facebook: accounts.facebook?.status ?? 'disconnected',
    instagram: accounts.instagram?.status ?? 'disconnected',
    tiktok: accounts.tiktok?.status ?? 'disconnected',
  } satisfies Record<PlatformId, AccountStatus>;
}
