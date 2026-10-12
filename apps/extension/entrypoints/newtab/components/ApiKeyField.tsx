import { useId, useState, type RefObject } from "react";
import { isLikelyGeminiKey } from "@homepage/agent-core";
import { btnSecondary, errorBox, textInput } from "./ui";

export function validateApiKey(value: string): string | null {
  const key = value.trim();
  if (!key) return "Paste your Google API key to continue.";
  if (!isLikelyGeminiKey(key)) {
    return "That doesn't look like a Google AI Studio key. Copy it again from aistudio.google.com/apikey.";
  }
  return null;
}

export function ApiKeyField({
  label,
  value,
  onChange,
  error,
  inputRef,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  error: string | null;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div>
      <label htmlFor={id} style={{ display: "block", fontSize: 14, color: "#333", marginBottom: 6 }}>
        {label}
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id={id}
          ref={inputRef}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste your Google AI Studio key"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          style={{
            ...textInput,
            flex: 1,
            minWidth: 0,
            borderColor: error ? "#a02620" : "#ddd",
          }}
        />
        <button
          type="button"
          style={btnSecondary}
          aria-label={visible ? "Hide key" : "Show key"}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {error && (
        <div
          id={errorId}
          role="alert"
          style={{ ...errorBox, marginTop: 8, padding: "8px 12px", borderRadius: 4 }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
