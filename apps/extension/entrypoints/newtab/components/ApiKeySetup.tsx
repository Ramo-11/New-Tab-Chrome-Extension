import { useRef, useState, type FormEvent } from "react";
import { ApiKeyField, validateApiKey } from "./ApiKeyField";
import { btn, noteBox } from "./ui";

export function ApiKeySetup({ onSave }: { onSave: (key: string) => Promise<void> | void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const problem = validateApiKey(value);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await onSave(value.trim());
    } catch {
      setError("The key could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 560, margin: "8vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>Connect your free Google AI key</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        AI Homepage writes your page with Google&apos;s Gemini models, which Google lets you use for
        free. Getting a key takes about a minute.
      </p>
      <ol style={{ color: "#333", lineHeight: 1.7, paddingLeft: 22 }}>
        <li>
          Open{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </a>{" "}
          and sign in with your Google account.
        </li>
        <li>
          Click <b>Create API key</b>. If it asks for a project, let it create a new one.
        </li>
        <li>Copy the key and paste it below.</li>
      </ol>
      <form noValidate onSubmit={submit}>
        <ApiKeyField
          label="Google API key"
          value={value}
          onChange={(next) => {
            setValue(next);
            if (error) setError(null);
          }}
          error={error}
          inputRef={inputRef}
          autoFocus
        />
        <button
          type="submit"
          style={{ ...btn, marginTop: 16, opacity: saving ? 0.6 : 1 }}
          disabled={saving}
        >
          {saving ? "Saving" : "Save key"}
        </button>
      </form>
      <div style={{ ...noteBox, marginTop: 24 }}>
        <p>
          <b>It is free as long as the key&apos;s Google project has no billing turned on.</b> Never
          add billing for this key. Without billing, Google can only refuse requests once the free
          daily limit is used up, so you can never be charged.
        </p>
        <p>
          On the free plan, Google may use what it receives to improve its products. Each build sends
          a summary of your browsing history and the text of the pages it reads. The &quot;Sites the
          agent never reads&quot; list in Settings controls what is left out, and you can review it
          before your first build.
        </p>
        <p>Your key stays in this browser and is only ever sent to Google.</p>
      </div>
    </div>
  );
}
