import { describe, expect, test } from "bun:test";
import { GeminiError, classifyError, createGeminiClient, extractOutputText } from "@homepage/agent-core";

interface Seen {
  url: string;
  key: string | null;
  accept: string | null;
  body: Record<string, unknown>;
}

type Handler = (seen: Seen, signal: AbortSignal) => Response | Promise<Response>;

async function withFetch<T>(handler: Handler, run: (seen: Seen[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const entry: Seen = {
      url: request.url,
      key: request.headers.get("x-goog-api-key"),
      accept: request.headers.get("accept"),
      body: JSON.parse(await request.text()),
    };
    seen.push(entry);
    const signal = init?.signal ?? request.signal;
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      Promise.resolve(handler(entry, signal)).then(resolve, reject);
    });
  }) as typeof fetch;
  try {
    return await run(seen);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const client = createGeminiClient("AIzaTestTestTestTestTestTestTestTestTes");

const streamEvents = (status: string) => [
  { event_type: "interaction.created", interaction: { id: "i1", status: "in_progress" } },
  { event_type: "step.start", index: 0, step: { type: "thought" } },
  { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "abc" } },
  { event_type: "step.stop", index: 0 },
  { event_type: "step.start", index: 1, step: { type: "model_output" } },
  { event_type: "step.delta", index: 1, delta: { type: "text", text: "import React from 'react';\n" } },
  { event_type: "step.delta", index: 1, delta: { type: "text", text: "export default function PersonalizedHomepage() {}" } },
  { event_type: "step.stop", index: 1 },
  { event_type: "interaction.completed", interaction: { id: "i1", status } },
];

describe("generateJson", () => {
  test("posts an unstored Interactions request and returns the model's text", async () => {
    await withFetch(
      () =>
        json({
          id: "i2",
          status: "completed",
          steps: [
            { type: "thought", signature: "xyz" },
            { type: "model_output", content: [{ type: "text", text: '{"urls":["https://lobste.rs/"]}' }] },
          ],
        }),
      async (seen) => {
        const text = await client.generateJson({
          model: "gemini-3.5-flash-lite",
          system: "SYSTEM",
          user: "USER",
          schema: { type: "object" },
        });
        expect(text).toBe('{"urls":["https://lobste.rs/"]}');
        expect(seen).toHaveLength(1);
        expect(seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
        expect(seen[0]!.key).toBe("AIzaTestTestTestTestTestTestTestTestTes");
        expect(seen[0]!.body).toEqual({
          model: "gemini-3.5-flash-lite",
          input: "USER",
          system_instruction: "SYSTEM",
          store: false,
          response_format: { type: "text", mime_type: "application/json", schema: { type: "object" } },
          generation_config: { max_output_tokens: 8192 },
        });
      },
    );
  });

  test("uses no paid feature and no server side state", async () => {
    await withFetch(
      () => json({ id: "i", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "{}" }] }] }),
      async (seen) => {
        await client.generateJson({ model: "m", system: "s", user: "u", schema: {} });
        const allowed = ["model", "input", "system_instruction", "store", "response_format", "generation_config", "stream"];
        expect(Object.keys(seen[0]!.body).every((key) => allowed.includes(key))).toBe(true);
        expect(seen[0]!.body.store).toBe(false);
      },
    );
  });

  test("an empty answer becomes a retryable server error", async () => {
    await withFetch(
      () => json({ id: "i", status: "failed", steps: [] }),
      async () => {
        const error = await client.generateJson({ model: "m", system: "s", user: "u", schema: {} }).catch((e: unknown) => e);
        expect(classifyError(error).kind).toBe("server");
        expect((error as Error).message).toContain("empty answer");
      },
    );
  });
});

describe("generateText", () => {
  test("streams, ignores thoughts and reports progress", async () => {
    await withFetch(
      () => sse(streamEvents("completed")),
      async (seen) => {
        const progress: number[] = [];
        const result = await client.generateText({
          model: "gemini-3.8-flash",
          system: "SYSTEM",
          user: "USER",
          onProgress: (chars) => progress.push(chars),
        });
        expect(result.text).toBe("import React from 'react';\nexport default function PersonalizedHomepage() {}");
        expect(result.truncated).toBe(false);
        expect(progress).toEqual([27, 76]);
        expect(seen[0]!.accept).toBe("text/event-stream");
        expect(seen[0]!.body).toEqual({
          model: "gemini-3.8-flash",
          input: "USER",
          system_instruction: "SYSTEM",
          store: false,
          stream: true,
          generation_config: { max_output_tokens: 32768 },
        });
      },
    );
  });

  test("flags an answer that did not complete", async () => {
    await withFetch(
      () => sse(streamEvents("incomplete")),
      async () => {
        const result = await client.generateText({ model: "m", system: "s", user: "u" });
        expect(result.truncated).toBe(true);
      },
    );
  });

  test("an error event in the stream is classified from its code", async () => {
    await withFetch(
      () =>
        sse([
          { event_type: "step.start", index: 0, step: { type: "model_output" } },
          { event_type: "error", error: { code: "service_unavailable", message: "high demand" } },
        ]),
      async () => {
        const error = await client.generateText({ model: "m", system: "s", user: "u" }).catch((e: unknown) => e);
        expect(classifyError(error).kind).toBe("server");
      },
    );
  });
});

describe("errors and cancellation", () => {
  test("a 429 is not retried inside the SDK and carries its quota scope", async () => {
    await withFetch(
      () =>
        json(
          { error: { message: "Rate limit exceeded for model x (limit: 20 requests per day on Free Tier)", code: "too_many_requests" } },
          429,
        ),
      async (seen) => {
        const error = await client.generateText({ model: "m", system: "s", user: "u" }).catch((e: unknown) => e);
        expect(seen).toHaveLength(1);
        expect(classifyError(error)).toMatchObject({ kind: "quota", scope: "day" });
      },
    );
  });

  test("a 503 is a server problem and is not retried inside the SDK", async () => {
    await withFetch(
      () => json({ error: { message: "gemini-3.8-flash is currently experiencing high demand.", code: "service_unavailable" } }, 503),
      async (seen) => {
        const error = await client.generateJson({ model: "m", system: "s", user: "u", schema: {} }).catch((e: unknown) => e);
        expect(seen).toHaveLength(1);
        expect(classifyError(error).kind).toBe("server");
      },
    );
  });

  test("a 404 for a model is a missing model", async () => {
    await withFetch(
      () => json({ error: { message: "This model is no longer available to new users.", code: "not_found" } }, 404),
      async () => {
        const error = await client.generateJson({ model: "m", system: "s", user: "u", schema: {} }).catch((e: unknown) => e);
        expect(classifyError(error).kind).toBe("model-missing");
      },
    );
  });

  test("cancelling while a request is in flight rejects with an abort", async () => {
    await withFetch(
      () => new Promise<Response>(() => undefined),
      async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const error = await client
          .generateJson({ model: "m", system: "s", user: "u", schema: {}, signal: controller.signal })
          .catch((e: unknown) => e);
        expect((error as Error).name).toBe("AbortError");
        expect(error).not.toBeInstanceOf(GeminiError);
      },
    );
  });
});

describe("extractOutputText", () => {
  test("joins model output text and skips thoughts", () => {
    expect(
      extractOutputText({
        steps: [
          { type: "thought", signature: "s" },
          { type: "model_output", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] },
        ],
      }),
    ).toBe("ab");
  });

  test("falls back to output_text and tolerates missing parts", () => {
    expect(extractOutputText({ steps: [], output_text: "fallback" })).toBe("fallback");
    expect(extractOutputText({})).toBe("");
    expect(extractOutputText({ steps: [null, 4, { type: "model_output" }] })).toBe("");
  });
});
