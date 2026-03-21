import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { buildTargetStates, platformDefinitions, validateComposer } from './shared/content';
import type {
  AppSnapshot,
  ComposerInput,
  ImportedAsset,
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
    await runAction('Selecting images', async () => {
      const result = await window.socialDesk.selectAssets();
      if (result.assets.length > 0) {
        setAssets(result.assets);
        setSuccess(`${result.assets.length} image${result.assets.length === 1 ? '' : 's'} selected.`);
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
            accounts={snapshot.accounts}
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

function AccountsView({
  accounts,
  onConnect,
  onValidate,
  onDisconnect,
}: {
  accounts: PlatformAccount[];
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
          const platformAccounts = accounts.filter((account) => account.platform === platform.id);
          return (
            <article className="panel" key={platform.id}>
              <div className="panel-header">
                <div>
                  <p className="eyebrow">{platform.badge}</p>
                  <h3>{platform.displayName}</h3>
                </div>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => onConnect(platform.id)}
                  disabled={!platform.enabled}
                >
                  {platform.enabled ? 'Connect account' : 'Scaffolded only'}
                </button>
              </div>
              <p className="muted-copy">{platform.description}</p>
              <div className="table-list">
                {platformAccounts.map((account) => (
                  <div className="row-card" key={account.id}>
                    <div>
                      <strong>{account.label}</strong>
                      <p>{account.detail}</p>
                    </div>
                    <div className="row-actions">
                      <StatusPill status={account.status} />
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
                ))}
                {platformAccounts.length === 0 ? (
                  <EmptyState text={`No ${platform.displayName} accounts connected yet.`} />
                ) : null}
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
          <span>Text + images only in v1</span>
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
              Choose images
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
                <span>{Math.round(asset.size / 1024)} KB</span>
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
          {assets.length === 0 ? <EmptyState text="No images added yet." compact /> : null}
        </div>

        <div className="platform-selector">
          {Object.values(platformDefinitions).map((platform) => (
            <label className="platform-toggle" key={platform.id}>
              <input
                type="checkbox"
                checked={selectedPlatforms.includes(platform.id)}
                onChange={() => onTogglePlatform(platform.id)}
              />
              <span>{platform.displayName}</span>
            </label>
          ))}
        </div>

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
                <StatusPill status={target.enabled ? 'connected' : 'attention'} />
              </div>
              <p>{body || 'Your draft text will preview here.'}</p>
              <div className="meta-grid">
                <span>{target.assetCount} images</span>
                <span>
                  {target.remainingCharacters === null
                    ? 'No shared limit'
                    : `${target.remainingCharacters} chars left`}
                </span>
              </div>
              <div className={target.enabled ? 'inline-note' : 'inline-note inline-note-error'}>
                {target.reason ?? 'Ready to publish.'}
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
