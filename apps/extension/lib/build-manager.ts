import { discardStaleCheckpoint, isAbortError, runHomepageBuild, type RunPhase } from "@homepage/agent-core";
import { rebuildIntervalMs, shouldAutoRebuild } from "./auto-rebuild";
import { browserBridge } from "./browser-bridge";
import {
  INITIAL_BUILD_STATE,
  LOG_RETENTION,
  stepForPhase,
  type BuildMsg,
  type BuildState,
  type PageMsg,
} from "./protocol";
import { KEYS, extensionStore, loadHomepage, loadSettings, saveHomepage } from "./storage";
import { findSyntaxError } from "./transpile";

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

const KEEPALIVE_INTERVAL_MS = 20_000;
const SNAPSHOT_THROTTLE_MS = 2_000;
const NARRATION_STORAGE_CAP = 2_000;

export class BuildManager {
  private state: BuildState = { ...INITIAL_BUILD_STATE };
  private readonly ports = new Set<Port>();
  private controller: AbortController | null = null;
  private running = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  attach(port: Port) {
    this.ports.add(port);
    port.onMessage.addListener((raw: unknown) => this.onPageMessage(port, raw as PageMsg));
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  private onPageMessage(port: Port, msg: PageMsg) {
    switch (msg.kind) {
      case "subscribe":
        this.send(port, { kind: "snapshot", state: this.state });
        break;
      case "startBuild":
        void this.startBuild({ resume: msg.resume });
        break;
      case "cancel":
        this.cancel();
        break;
    }
  }

  private send(port: Port, msg: BuildMsg) {
    try {
      port.postMessage(msg);
    } catch {
      this.ports.delete(port);
    }
  }

  private broadcast(msg: BuildMsg) {
    for (const port of [...this.ports]) this.send(port, msg);
  }

  async tick() {
    if (this.running) {
      this.startKeepalive();
      return;
    }

    await discardStaleCheckpoint(extensionStore);
    const checkpoint = await extensionStore.get<unknown>(KEYS.buildCheckpoint);
    if (checkpoint !== undefined) {
      const { apiKey } = await loadSettings();
      if (apiKey) {
        void this.startBuild({ resume: true });
        return;
      }
    }

    await this.maybeAutoRebuild();
  }

  private async maybeAutoRebuild() {
    const [settings, homepage, lastAttempt] = await Promise.all([
      loadSettings(),
      loadHomepage(),
      extensionStore.get<string>(KEYS.lastAutoBuildAttempt),
    ]);
    const now = new Date();

    if (
      !shouldAutoRebuild({
        enabled: settings.autoRebuild,
        hasApiKey: Boolean(settings.apiKey),
        isRunning: this.running,
        lastBuildTimestamp: homepage?.timestamp,
        lastAutoAttemptTimestamp: lastAttempt,
        intervalMs: rebuildIntervalMs(settings.rebuildIntervalHours),
        now,
      })
    ) {
      return;
    }

    await extensionStore.set(KEYS.lastAutoBuildAttempt, now.toISOString());
    void this.startBuild({ resume: false });
  }

  async startBuild(opts: { resume?: boolean } = {}) {
    if (this.running) {
      console.log("[BuildManager] startBuild ignored, a build is already running");
      return;
    }
    this.running = true;

    try {
      const { apiKey, systemPrompt, model, newsSources } = await loadSettings();
      if (!apiKey) {
        console.warn("[BuildManager] startBuild aborted, no API key in storage");
        const message = "No Google API key found. Add your key and try again.";
        this.state = { ...INITIAL_BUILD_STATE, phase: "error", error: message };
        this.broadcast({ kind: "error", message });
        return;
      }

      this.controller = new AbortController();
      this.state = { ...INITIAL_BUILD_STATE, running: true, phase: "setup" };
      this.broadcast({ kind: "snapshot", state: this.state });
      this.startKeepalive();
      console.log("[BuildManager] build started", { resume: Boolean(opts.resume) });

      const result = await runHomepageBuild({
        apiKey,
        bridge: browserBridge,
        store: extensionStore,
        userSystemPrompt: systemPrompt,
        blockedSites: async () => (await loadSettings()).blockedSites,
        model,
        newsSources,
        resume: opts.resume,
        signal: this.controller.signal,
        checkSyntax: findSyntaxError,
        callbacks: {
          onPhase: (phase, detail) => this.onPhase(phase, detail),
          onText: (chunk) => this.onText(chunk),
          onLog: (line) => this.onLog(line),
        },
      });

      await saveHomepage(result.code);

      this.state = { ...this.state, running: false, phase: "done" };
      this.broadcast({ kind: "done", code: result.code });
      await this.mirror(true);
      console.log("[BuildManager] build done", {
        bytes: result.code.length,
        model: result.model,
        repaired: result.repaired,
      });
    } catch (error) {
      if (isAbortError(error)) {
        this.state = { ...this.state, running: false, phase: null, cancelled: true };
        this.broadcast({ kind: "cancelled" });
        await this.mirror(true);
        console.log("[BuildManager] build cancelled");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, running: false, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      await this.mirror(true);
      this.notifyFailure(message);
      console.error("[BuildManager] build failed", error);
    } finally {
      this.running = false;
      this.controller = null;
      this.stopKeepalive();
    }
  }

  cancel() {
    this.controller?.abort();
  }

  private onPhase(phase: RunPhase, detail?: string) {
    const mapped = stepForPhase(phase);
    const stepIndex =
      mapped === undefined ? this.state.stepIndex : Math.max(this.state.stepIndex, mapped);
    this.state = { ...this.state, phase, stepIndex, detail: detail ?? "" };
    this.broadcast({ kind: "phase", phase, stepIndex, detail: detail ?? "" });
    void this.mirror(false);
  }

  private onText(chunk: string) {
    this.state = { ...this.state, narration: this.state.narration + chunk };
    this.broadcast({ kind: "text", chunk });
    void this.mirror(false);
  }

  private onLog(line: string) {
    this.state = { ...this.state, logs: [...this.state.logs.slice(-LOG_RETENTION), line] };
    this.broadcast({ kind: "log", line });
    void this.mirror(false);
  }

  private async mirror(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) {
      this.snapshotTimer ??= setTimeout(() => {
        this.snapshotTimer = null;
        void this.mirror(true);
      }, SNAPSHOT_THROTTLE_MS);
      return;
    }

    this.lastSnapshotAt = now;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    const trimmed: BuildState = {
      ...this.state,
      narration: this.state.narration.slice(-NARRATION_STORAGE_CAP),
      logs: this.state.logs.slice(-LOG_RETENTION),
    };
    await extensionStore.set(KEYS.buildSnapshot, trimmed);
  }

  private startKeepalive() {
    this.keepalive ??= setInterval(() => {
      void browser.runtime.getPlatformInfo();
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private notifyFailure(message: string) {
    if (this.ports.size > 0) return;
    try {
      browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: "Homepage build failed",
        message: message.slice(0, 200),
      });
    } catch {
      return;
    }
  }
}
