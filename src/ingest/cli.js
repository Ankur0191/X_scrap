import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePost } from "./normalize.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const inputFlag = args.indexOf("--input");
const inputPath = inputFlag >= 0 ? path.resolve(args[inputFlag + 1] ?? "") : "";
if (!inputPath || !fs.existsSync(inputPath)) {
  console.error("Usage: npm run ingest -- --input <json-or-jsonl-file>");
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const allowed = new Set(config.competitors.filter((c) => c.enabled).map((c) => c.username.replace(/^@/, "").toLowerCase()));
if (allowed.size === 0) {
  console.error("No competitors enabled. Edit config/competitors.json first.");
  process.exit(2);
}

const raw = fs.readFileSync(inputPath, "utf8").trim();
if (!raw) {
  console.log("Input file is empty; nothing to ingest.");
  process.exit(0);
}
let records;
try {
  records = raw.startsWith("[") ? JSON.parse(raw) : raw.split(/\\r?\\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSON on line ${i + 1}`); }
  });
  if (!Array.isArray(records)) throw new Error("JSON input must contain an array or JSONL records");
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const outputDir = path.join(root, "data/output");
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "posts.jsonl");
const seen = new Set();
if (fs.existsSync(outputPath)) {
  for (const line of fs.readFileSync(outputPath, "utf8").split(/\\r?\\n/).filter(Boolean)) {
    try { seen.add(String(JSON.parse(line).id)); } catch { /* leave malformed legacy line untouched */ }
  }
}
const accepted = [];
const errors = [];
for (const [index, record] of records.entries()) {
  try {
    const post = normalizePost(record);
    if (!allowed.has(post.authorUsername)) continue;
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    accepted.push(post);
  } catch (error) {
    errors.push({ row: index + 1, error: error.message });
  }
}
if (accepted.length) fs.appendFileSync(outputPath, accepted.map((p) => JSON.stringify(p)).join("\\n") + "\\n");
console.log(JSON.stringify({ inputRecords: records.length, accepted: accepted.length, skippedOrDuplicate: records.length - accepted.length - errors.length, errors, outputPath }, null, 2));
if (errors.length) process.exitCode = 1;
