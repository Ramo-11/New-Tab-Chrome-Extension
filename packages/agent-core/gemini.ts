import { GoogleGenAI } from "@google/genai";
import { abortError } from "./errors";

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface JsonRequest extends LlmRequest {
  schema: Record<string, unknown>;
}

export interface TextRequest extends LlmRequest {
  onProgress?: (chars: number) => void;
}

export interface TextResult {
  text: string;
  truncated: boolean;
}

export interface LlmClient {
  generateJson(request: JsonRequest): Promise<string>;
  generateText(request: TextRequest): Promise<TextResult>;
}

export const JSON_MAX_OUTPUT_TOKENS = 8_192;
export const TEXT_MAX_OUTPUT_TOKENS = 32_768;
export const JSON_IDLE_TIMEOUT_MS = 60_000;
export const TEXT_IDLE_TIMEOUT_MS = 120_000;

interface Guard {
  signal: AbortSignal;
  touch(): void;
  stop(): void;
  timedOut(): boolean;
}

function guard(external: AbortSignal | undefined, idleMs: number): Guard {
  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, idleMs);
  };
  const onAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  external?.addEventListener("abort", onAbort, { once: true });
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    stop() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
    timedOut: () => expired,
  };
}

function timeoutError(): Error {
  return Object.assign(new Error("Google took too long to answer."), { status: 504, timedOut: true });
}

function emptyAnswerError(reason: string | undefined): Error {
  const detail = reason ? ` (${reason})` : "";
  return Object.assign(new Error(`Google returned an empty answer${detail}. Try again.`), { status: 503 });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function extractOutputText(interaction: { steps?: unknown; output_text?: unknown }): string {
  let text = "";
  if (Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      const entry = asRecord(step);
      if (entry?.type !== "model_output" || !Array.isArray(entry.content)) continue;
      for (const part of entry.content) {
        const item = asRecord(part);
        if (item?.type === "text" && typeof item.text === "string") text += item.text;
      }
    }
  }
  if (!text && typeof interaction.output_text === "string") return interaction.output_text;
  return text;
}

function streamError(error: unknown): Error {
  const detail = asRecord(error);
  const message = typeof detail?.message === "string" ? detail.message : "Google reported an error.";
  return new Error(JSON.stringify({ error: { message, code: detail?.code } }));
}

export function createGeminiClient(apiKey: string): LlmClient {
  const ai = new GoogleGenAI({ apiKey });

  return {
    async generateJson({ model, system, user, schema, signal }) {
      const watch = guard(signal, JSON_IDLE_TIMEOUT_MS);
      try {
        const interaction = await ai.interactions.create(
          {
            model,
            input: user,
            system_instruction: system,
            store: false,
            response_format: { type: "text", mime_type: "application/json", schema },
            generation_config: { max_output_tokens: JSON_MAX_OUTPUT_TOKENS },
          },
          { signal: watch.signal, retries: { strategy: "none" } },
        );
        const text = extractOutputText(interaction);
        if (!text.trim()) throw emptyAnswerError(interaction.status);
        return text;
      } catch (error) {
        if (watch.timedOut()) throw timeoutError();
        if (signal?.aborted) throw abortError();
        throw error;
      } finally {
        watch.stop();
      }
    },

    async generateText({ model, system, user, signal, onProgress }) {
      const watch = guard(signal, TEXT_IDLE_TIMEOUT_MS);
      try {
        const stream = await ai.interactions.create(
          {
            model,
            input: user,
            system_instruction: system,
            store: false,
            stream: true,
            generation_config: { max_output_tokens: TEXT_MAX_OUTPUT_TOKENS },
          },
          { signal: watch.signal, retries: { strategy: "none" } },
        );

        let text = "";
        let status: string | undefined;
        let finalSteps: unknown;
        const stepTypes = new Map<number, string>();

        for await (const event of stream) {
          watch.touch();
          switch (event.event_type) {
            case "step.start":
              stepTypes.set(event.index, event.step.type);
              break;
            case "step.delta":
              if (event.delta.type === "text" && (stepTypes.get(event.index) ?? "model_output") === "model_output") {
                text += event.delta.text;
                onProgress?.(text.length);
              }
              break;
            case "interaction.status_update":
              status = event.status;
              break;
            case "interaction.completed":
              status = event.interaction.status;
              finalSteps = event.interaction.steps;
              break;
            case "error":
              throw streamError(event.error);
          }
        }

        if (!text.trim() && finalSteps) text = extractOutputText({ steps: finalSteps });
        if (!text.trim()) throw emptyAnswerError(status);
        return { text, truncated: status !== undefined && status !== "completed" };
      } catch (error) {
        if (watch.timedOut()) throw timeoutError();
        if (signal?.aborted) throw abortError();
        throw error;
      } finally {
        watch.stop();
      }
    },
  };
}
