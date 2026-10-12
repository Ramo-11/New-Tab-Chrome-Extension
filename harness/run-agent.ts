import { MODEL_CHOICES, isHomepageModel, runHomepageBuild, validateHomepage } from "@homepage/agent-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { FileKVStore, OUT_DIR, OUT_PATH, STATE_PATH, nodeBridge } from "./node-bridge";
import { checkSyntax } from "./syntax";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (put it in .env)");

  const requested = process.env.HOMEPAGE_MODEL;
  if (requested && !isHomepageModel(requested)) {
    throw new Error(`HOMEPAGE_MODEL must be one of: ${MODEL_CHOICES.map((m) => m.id).join(", ")}`);
  }

  const store = new FileKVStore(STATE_PATH);
  mkdirSync(OUT_DIR, { recursive: true });

  const started = Date.now();
  let lastPhase = "";

  const result = await runHomepageBuild({
    apiKey,
    bridge: nodeBridge,
    store,
    userSystemPrompt: process.env.HOMEPAGE_PROMPT,
    model: requested && isHomepageModel(requested) ? requested : undefined,
    checkSyntax,
    callbacks: {
      onPhase: (phase, detail) => {
        if (phase !== lastPhase) {
          lastPhase = phase;
          process.stdout.write(`\n[${phase}]${detail ? " " + detail : ""}\n`);
        }
      },
      onText: (text) => process.stdout.write(text),
      onLog: (line) => process.stdout.write(`  - ${line}\n`),
    },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  writeFileSync(OUT_PATH, result.code);

  console.log("\n========== RESULT ==========");
  console.log(`model        : ${result.model}`);
  console.log(`repaired     : ${result.repaired}`);
  console.log(`code length  : ${result.code.length} bytes`);
  console.log(`elapsed      : ${elapsed}s`);
  console.log(`written to   : ${OUT_PATH}`);

  const report = validateHomepage(result.code, { knownLinks: [], checkSyntax });
  console.log("\n========== CONTRACT ==========");
  if (report.blocking.length === 0) console.log("PASS contract checks");
  for (const problem of report.blocking) console.log(`FAIL ${problem}`);
  console.log("\nNext: pnpm agent:verify");

  process.exit(report.blocking.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[run-agent] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
