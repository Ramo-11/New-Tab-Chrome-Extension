import { useRef, useState, type FormEvent } from "react";
import { MAX_NEWS_SOURCES, MODEL_CHOICES, normalizeBlockList, parseNewsSources, type HomepageModel } from "@homepage/agent-core";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { ApiKeyField, validateApiKey } from "./ApiKeyField";
import { btn, btnSecondary } from "./ui";

export function SettingsModal({
  initialPrompt,
  blockedSites,
  newsSources,
  apiKey,
  onChangeApiKey,
  model,
  onChangeModel,
  autoRebuild,
  openTabs,
  onToggleOpenTabs,
  onToggleAutoRebuild,
  intervalHours,
  onChangeInterval,
  onClose,
  onSave,
}: {
  initialPrompt: string;
  blockedSites: string[];
  newsSources: string[];
  apiKey: string;
  onChangeApiKey: (key: string) => Promise<void>;
  model: HomepageModel;
  onChangeModel: (next: HomepageModel) => void;
  autoRebuild: boolean;
  openTabs: boolean;
  onToggleOpenTabs: (next: boolean) => void;
  onToggleAutoRebuild: (next: boolean) => void;
  intervalHours: number;
  onChangeInterval: (next: number) => void;
  onClose: () => void;
  onSave: (prompt: string, blockedSites: string[], newsSources: string[]) => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [blockedDraft, setBlockedDraft] = useState(blockedSites.join("\n"));
  const [newsDraft, setNewsDraft] = useState(newsSources.join("\n"));
  const [newsError, setNewsError] = useState<string | null>(null);
  const newsInputRef = useRef<HTMLTextAreaElement>(null);

  const save = () => {
    const parsed = parseNewsSources(newsDraft.split("\n"));
    const problem =
      parsed.invalid.length > 0
        ? `These lines are not web addresses: ${parsed.invalid.slice(0, 3).join(", ")}${parsed.invalid.length > 3 ? ", and more" : ""}.`
        : parsed.overLimit
          ? `Keep the list to ${MAX_NEWS_SOURCES} sites or fewer, so a build finishes in a few minutes.`
          : null;
    if (problem) {
      setNewsError(problem);
      newsInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      newsInputRef.current?.focus();
      return;
    }
    onSave(draft, normalizeBlockList(blockedDraft.split("\n")), parsed.sources);
  };
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  const [keySaving, setKeySaving] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);

  const submitKey = async (e: FormEvent) => {
    e.preventDefault();
    if (keySaving) return;
    setKeyNotice(null);
    const problem = validateApiKey(keyDraft);
    if (problem) {
      setKeyError(problem);
      keyInputRef.current?.focus();
      return;
    }
    setKeySaving(true);
    try {
      await onChangeApiKey(keyDraft.trim());
      setKeyDraft("");
      setKeyError(null);
      setKeyNotice("Key replaced. It is used from your next build.");
    } catch {
      setKeyError("The key could not be saved. Please try again.");
    } finally {
      setKeySaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ backgroundColor: "white", borderRadius: 8, padding: 24, width: "90%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ marginTop: 0, color: "#333" }}>Customize your homepage</h2>
        <p style={{ color: "#666" }}>Standing instructions applied to every build.</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 'Top news in tech, then politics in America, Egypt and the world, then Barcelona'"
          style={{
            width: "100%",
            boxSizing: "border-box",
            minHeight: 200,
            padding: 12,
            fontSize: 14,
            borderRadius: 4,
            border: "1px solid #ddd",
            fontFamily: "inherit",
          }}
        />
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          News sites it reads on every build
          <textarea
            ref={newsInputRef}
            value={newsDraft}
            onChange={(e) => {
              setNewsDraft(e.target.value);
              if (newsError) setNewsError(null);
            }}
            aria-invalid={newsError ? true : undefined}
            aria-describedby="news-sources-help"
            style={{
              width: "100%",
              boxSizing: "border-box",
              minHeight: 160,
              marginTop: 8,
              padding: 12,
              fontSize: 14,
              borderRadius: 4,
              border: `1px solid ${newsError ? "#c0392b" : "#ddd"}`,
              fontFamily: "inherit",
            }}
          />
        </label>
        {newsError && (
          <p role="alert" style={{ color: "#a02620", fontSize: 13, margin: "6px 0 0" }}>
            {newsError}
          </p>
        )}
        <p id="news-sources-help" style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          One web address per line, up to {MAX_NEWS_SOURCES}. These front pages give the homepage its
          top stories. Sites from your own history are added in a smaller section at the end. More
          sites make a build take longer.
        </p>
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Sites the agent never reads
          <textarea
            value={blockedDraft}
            onChange={(e) => setBlockedDraft(e.target.value)}
            aria-describedby="blocked-sites-help"
            style={{ width: "100%", boxSizing: "border-box", minHeight: 120, marginTop: 8, padding: 12, fontSize: 14, borderRadius: 4, border: "1px solid #ddd", fontFamily: "inherit" }}
          />
        </label>
        <p id="blocked-sites-help" style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          One per line. Subdomains are included. Use *.example.com for wildcards. Nothing from
          these sites is sent to Google. On the free plan, Google may use what it does receive to
          improve its products.
        </p>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, color: "#333", fontSize: 14 }}
        >
          Model
          <select
            value={model}
            onChange={(e) => onChangeModel(e.target.value as HomepageModel)}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {MODEL_CHOICES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          All of these models are free. If the one you pick runs out of free uses for the day, the
          build automatically uses the next one.
        </p>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input type="checkbox" checked={openTabs} onChange={(e) => onToggleOpenTabs(e.target.checked)} />
          Open tabs for sites that can't be read quietly
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          Most sites are read in the background with no tabs. A few, such as Reuters, Politico,
          LinkedIn and X, only work in a real tab. With this off they are skipped. With it on they
          open in a minimized window that closes by itself.
        </p>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRebuild}
            onChange={(e) => onToggleAutoRebuild(e.target.checked)}
          />
          Rebuild automatically
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            marginLeft: 24,
            color: autoRebuild ? "#333" : "#aaa",
            fontSize: 14,
          }}
        >
          Every
          <select
            value={intervalHours}
            disabled={!autoRebuild}
            onChange={(e) => onChangeInterval(Number(e.target.value))}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {REBUILD_INTERVAL_CHOICES.map((h) => (
              <option key={h} value={h}>
                {h === 24 ? "24 hours (daily)" : `${h} hours`}
              </option>
            ))}
          </select>
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          When on, the extension rebuilds in the background once your homepage is this old, so
          your next tab shows a fresh one (uses part of your free daily allowance).
        </p>
        <form
          noValidate
          onSubmit={submitKey}
          style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #eee" }}
        >
          <ApiKeyField
            label="Replace your Google API key"
            value={keyDraft}
            onChange={(next) => {
              setKeyDraft(next);
              if (keyError) setKeyError(null);
              if (keyNotice) setKeyNotice(null);
            }}
            error={keyError}
            inputRef={keyInputRef}
          />
          <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
            Current key ends in {apiKey.slice(-4)}. Get a new one at aistudio.google.com/apikey, from
            a project with no billing turned on.
          </p>
          {keyNotice && (
            <p role="status" style={{ color: "#1a7f4b", fontSize: 13, margin: "8px 0 0" }}>
              {keyNotice}
            </p>
          )}
          <button
            type="submit"
            disabled={keySaving}
            style={{ ...btnSecondary, marginTop: 10, opacity: keySaving ? 0.6 : 1 }}
          >
            {keySaving ? "Saving" : "Replace key"}
          </button>
        </form>
        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            Cancel
          </button>
          <button onClick={save} style={btn}>
            Save &amp; rebuild
          </button>
        </div>
      </div>
    </div>
  );
}
