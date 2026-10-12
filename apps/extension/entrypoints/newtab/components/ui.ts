import type { CSSProperties } from "react";

export const btn: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 4,
  border: "none",
  backgroundColor: "#0066cc",
  color: "white",
  cursor: "pointer",
  fontSize: 14,
};

export const errorBox: CSSProperties = {
  background: "#fdeceb",
  border: "1px solid #f5c6cb",
  color: "#a02620",
  fontSize: 13,
};

export const btnSecondary: CSSProperties = {
  ...btn,
  backgroundColor: "white",
  color: "#333",
  border: "1px solid #ddd",
};

export const noteBox: CSSProperties = {
  background: "#f6f8fb",
  border: "1px solid #e2e6ee",
  color: "#333",
  fontSize: 13,
  lineHeight: 1.55,
  padding: "4px 14px",
  borderRadius: 4,
};

export const textInput: CSSProperties = {
  padding: 12,
  fontSize: 14,
  borderRadius: 4,
  border: "1px solid #ddd",
  fontFamily: "ui-monospace, monospace",
};
