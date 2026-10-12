import { transform, type Transform } from "sucrase";

const TRANSFORMS: Transform[] = ["typescript", "imports", "jsx"];

/**
 * Turn the agent's TSX into JS that Sandpack's React template can run. If the
 * transform throws, fall back to the raw source — Sandpack compiles TSX too.
 */
export function toRenderable(tsx: string): string {
  try {
    return transform(tsx, { transforms: TRANSFORMS }).code.replace(`"use strict";`, "");
  } catch (err) {
    console.warn("[transpile] sucrase failed, using raw source", err);
    return tsx;
  }
}

export function findSyntaxError(tsx: string): string | null {
  try {
    transform(tsx, { transforms: TRANSFORMS });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
