import { useCallback, useEffect, useState } from "react";
import { DEFAULT_MODEL, DEFAULT_BLOCKED_SITES, DEFAULT_NEWS_SOURCES, type HomepageModel } from "@homepage/agent-core";
import { DEFAULT_REBUILD_INTERVAL_HOURS } from "@/lib/auto-rebuild";
import { BUILD_STEPS } from "@/lib/protocol";
import { hasFreshCheckpoint, loadHomepage, loadSettings, saveSetting } from "@/lib/storage";
import { toRenderable } from "@/lib/transpile";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { BuildProgress } from "./components/BuildProgress";
import { HomepagePreview } from "./components/HomepagePreview";
import { SettingsModal } from "./components/SettingsModal";
import { btn, btnSecondary, errorBox, noteBox } from "./components/ui";
import { useHomepageBuild } from "./useHomepageBuild";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [blockedSites, setBlockedSites] = useState<string[]>(DEFAULT_BLOCKED_SITES);
  const [newsSources, setNewsSources] = useState<string[]>(DEFAULT_NEWS_SOURCES);
  const [model, setModel] = useState<HomepageModel>(DEFAULT_MODEL);
  const [autoRebuild, setAutoRebuild] = useState(true);
  const [openTabs, setOpenTabs] = useState(false);
  const [intervalHours, setIntervalHours] = useState(DEFAULT_REBUILD_INTERVAL_HOURS);
  /** Transpiled homepage, ready for Sandpack. */
  const [renderedCode, setRenderedCode] = useState<string | null>(null);
  /** A build left mid-flight, offered as "Resume interrupted build". */
  const [resumable, setResumable] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over an existing homepage. */
  const [viewProgress, setViewProgress] = useState(false);
  /** The error the user dismissed, so a stale banner doesn't linger. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [builtAt, setBuiltAt] = useState<Date | null>(null);

  const { state, build, cancel } = useHomepageBuild((code) => {
    setRenderedCode(toRenderable(code));
    setBuiltAt(new Date());
  });

  // Once a build finishes, drop back to the homepage view.
  useEffect(() => {
    if (!state.running) setViewProgress(false);
  }, [state.running]);

  useEffect(() => {
    if (state.running) return;
    void hasFreshCheckpoint().then(setResumable);
  }, [state.running]);

  // Scheduled rebuilds are driven by the worker's alarm, not by opening a tab;
  // useHomepageBuild surfaces any build already in flight.
  useEffect(() => {
    (async () => {
      try {
        const [settings, homepage] = await Promise.all([loadSettings(), loadHomepage()]);
        setApiKey(settings.apiKey);
        setSystemPrompt(settings.systemPrompt);
        setBlockedSites(settings.blockedSites);
        setNewsSources(settings.newsSources);
        setModel(settings.model);
        setAutoRebuild(settings.autoRebuild);
        setOpenTabs(settings.openTabs);
        setIntervalHours(settings.rebuildIntervalHours ?? DEFAULT_REBUILD_INTERVAL_HOURS);
        if (homepage?.code) {
          setRenderedCode(toRenderable(homepage.code));
          setBuiltAt(new Date(homepage.timestamp));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveKey = useCallback(async (key: string) => {
    await saveSetting("apiKey", key);
    setApiKey(key);
  }, []);

  const savePrompt = useCallback(
    async (prompt: string, sites: string[], news: string[]) => {
      await Promise.all([
        saveSetting("systemPrompt", prompt),
        saveSetting("blockedSites", sites),
        saveSetting("newsSources", news),
      ]);
      setBlockedSites(sites);
      setNewsSources(news);
      setSystemPrompt(prompt);
      setShowSettings(false);
      setRenderedCode(null);
      build();
    },
    [build],
  );

  // These persist immediately; the worker reads them on its next heartbeat or build.
  const changeModel = useCallback(async (next: HomepageModel) => {
    setModel(next);
    await saveSetting("model", next);
  }, []);
  const toggleAutoRebuild = useCallback(async (next: boolean) => {
    setAutoRebuild(next);
    await saveSetting("autoRebuild", next);
  }, []);
  const toggleOpenTabs = useCallback(async (next: boolean) => {
    setOpenTabs(next);
    await saveSetting("openTabs", next);
  }, []);
  const changeInterval = useCallback(async (next: number) => {
    setIntervalHours(next);
    await saveSetting("rebuildIntervalHours", next);
  }, []);

  if (loading) return <div style={{ padding: 20, textAlign: "center" }}>Loading…</div>;
  if (!apiKey) return <ApiKeySetup onSave={saveKey} />;

  const settingsModal = showSettings && (
    <SettingsModal
      initialPrompt={systemPrompt}
      blockedSites={blockedSites}
      newsSources={newsSources}
      apiKey={apiKey}
      onChangeApiKey={saveKey}
      model={model}
      onChangeModel={changeModel}
      autoRebuild={autoRebuild}
      openTabs={openTabs}
      onToggleOpenTabs={toggleOpenTabs}
      onToggleAutoRebuild={toggleAutoRebuild}
      intervalHours={intervalHours}
      onChangeInterval={changeInterval}
      onClose={() => setShowSettings(false)}
      onSave={savePrompt}
    />
  );

  // With no homepage to fall back to, a running build takes over the tab.
  if (state.running && (!renderedCode || viewProgress)) {
    return (
      <BuildProgress
        state={state}
        onCancel={cancel}
        onBack={renderedCode ? () => setViewProgress(false) : undefined}
      />
    );
  }

  if (!renderedCode) {
    return (
      <div style={{ maxWidth: 560, margin: "14vh auto", padding: 24, fontFamily: "system-ui" }}>
        <h1 style={{ fontSize: 26 }}>Build your homepage</h1>
        <p style={{ color: "#555", lineHeight: 1.6 }}>
          The agent reads your browsing history, opens the pages you actually follow, and writes a
          homepage from what it finds today.
        </p>
        {state.error && (
          <div style={{ ...errorBox, margin: "16px 0", padding: 12, borderRadius: 4 }}>{state.error}</div>
        )}
        {state.cancelled && !state.error && (
          <div style={{ ...noteBox, margin: "16px 0", padding: 12 }}>
            Build cancelled. You can build again whenever you are ready.
          </div>
        )}
        <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
          <button style={btn} onClick={() => build()}>
            Build today&apos;s homepage
          </button>
          {resumable && (
            <button style={{ ...btn, backgroundColor: "#555" }} onClick={() => build({ resume: true })}>
              Resume interrupted build
            </button>
          )}
          <button style={btnSecondary} onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
        {settingsModal}
      </div>
    );
  }

  const showError = state.error && dismissedError !== state.error;

  return (
    <div className="hb-shell">
      <div className="hb-toolbar">
        {state.running ? (
          <button className="hb-status hb-status-live" onClick={() => setViewProgress(true)} title="View build progress">
            <span className="hb-dot" />
            Building, step {Math.min(state.stepIndex + 1, BUILD_STEPS.length)} of {BUILD_STEPS.length}
          </button>
        ) : (
          <span className="hb-status">{builtAt ? `Updated ${formatBuiltAt(builtAt)}` : "AI Homepage"}</span>
        )}
        <div className="hb-actions">
          {!state.running && (
            <button className="hb-tool-btn" onClick={() => build()}>
              Rebuild
            </button>
          )}
          <button className="hb-tool-btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </div>

      {showError && (
        <div className="hb-error-bar" role="alert">
          <span>
            <b>Build failed.</b> {state.error}
          </span>
          <div className="hb-actions">
            <button className="hb-tool-btn" onClick={() => build()}>
              Retry
            </button>
            <button className="hb-tool-btn" onClick={() => setDismissedError(state.error)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="hb-page">
        <HomepagePreview code={renderedCode} />
      </div>

      {settingsModal}
    </div>
  );
}

function formatBuiltAt(date: Date): string {
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `today at ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday at ${time}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${time}`;
}
