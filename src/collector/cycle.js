import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const threadLimit = Math.max(1, Number(config.collection?.monitorThreadRootsPerCycle || 5));
const windowDays = Math.max(1, Number(config.collection?.windowDays || 365));
const node = process.execPath;
const startedAt = new Date().toISOString();

const steps = [
  {
    name: "collect_latest_competitor_timelines",
    script: "src/collector/run.js",
    args: []
  },
  {
    name: "materialize_rolling_365_day_posts",
    script: "src/intelligence/build-window.js",
    args: []
  },
  {
    name: "refresh_conversation_root_queue",
    script: "src/collector/build-thread-queue.js",
    args: []
  },
  {
    name: "collect_public_thread_replies",
    script: "src/collector/threads.js",
    args: ["--limit", String(threadLimit)]
  },
  {
    name: "build_merged_conversation_dataset",
    script: "src/intelligence/build-conversation.js",
    args: []
  },
  {
    name: "audit_merged_conversation_dataset",
    script: "src/ingest/audit.js",
    args: ["data/output/conversation-" + windowDays + "d.jsonl"]
  }
];

const results = [];
let failed = false;
console.log("Rivalmap X intelligence monitoring cycle");
console.log("Started: " + startedAt);
console.log("Rolling window: " + windowDays + " days");
console.log("Conversation roots this cycle: " + threadLimit);

for (const step of steps) {
  const stepStarted = new Date().toISOString();
  console.log("\n=== " + step.name + " ===");
  const result = spawnSync(node, [step.script, ...step.args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, X_NONINTERACTIVE: "1" },
    windowsHide: false
  });
  const entry = {
    step: step.name,
    script: step.script,
    args: step.args,
    startedAt: stepStarted,
    completedAt: new Date().toISOString(),
    exitCode: result.status,
    error: result.error ? result.error.message : null
  };
  results.push(entry);
  if (result.error || result.status !== 0) {
    failed = true;
    console.error("Cycle halted at " + step.name + ". Fix the error before restarting.");
    break;
  }
}

const summary = {
  startedAt,
  completedAt: new Date().toISOString(),
  status: failed ? "failed" : "completed",
  threadRootsLimit: threadLimit,
  steps: results
};
const outputDir = path.join(root, "data/output");
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
fs.appendFileSync(path.join(outputDir, "cycle-runs.jsonl"), JSON.stringify(summary) + "\n", {
  encoding: "utf8",
  mode: 0o600
});
console.log("\nMonitoring cycle summary:");
console.log(JSON.stringify(summary, null, 2));
if (failed) process.exitCode = 1;
