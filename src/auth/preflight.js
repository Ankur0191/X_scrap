import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { profileDir, profileStatus } from "./profile.js";

const status = profileStatus();
console.log("\\n=== X local browser profile preflight ===");
console.log(`Profile directory: ${status.path}`);
console.log(`Profile exists: ${status.exists ? "yes" : "no"}`);
console.log(`Profile initialized: ${status.looksInitialized ? "yes" : "no"}`);
console.log("Note: cookie presence/expiry is not treated as proof of a valid X session.");

if (!status.exists || !status.looksInitialized) {
  console.log("\\nNo initialized local Chromium profile found.");
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question("Open headed Chromium for a manual session setup now? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer === "y" || answer === "yes") {
    const { spawn } = await import("node:child_process");
    const { projectRoot } = await import("./profile.js");
    const child = spawn(process.execPath, [new URL("./manual-session.js", import.meta.url).pathname], {
      cwd: projectRoot, stdio: "inherit"
    });
    child.on("exit", (code) => process.exitCode = code ?? 1);
  } else {
    console.log("Run npm run auth:setup when ready.");
  }
  process.exit(0);
}

console.log("\\nOpening a headed, read-only sign-in diagnostic. No cookies or tokens are exported.");
let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 960 }
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log(`Current URL: ${page.url()}`);
  console.log("Complete any challenge or MFA manually. The tool will not bypass it.");
  const rl = readline.createInterface({ input, output });
  await rl.question("Press Enter after inspecting the page to close the diagnostic browser...");
  rl.close();
} catch (error) {
  console.error("Preflight failed:", error.message);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
}
