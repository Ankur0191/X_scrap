import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { profileDir, profileStatus } from "./profile.js";
import { inspectSignedInState, launchPersistentSession } from "./session.js";

const ask = async (question) => {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(question)).trim(); }
  finally { rl.close(); }
};

const status = profileStatus();
console.log("\n=== X browser-session preflight ===");
console.log("Profile directory: " + profileDir);
console.log("Profile exists: " + (status.exists ? "yes" : "no"));
console.log("Profile initialized: " + (status.looksInitialized ? "yes" : "no"));
console.log("Session validity is checked by opening X, not by trusting cookie expiry metadata.");

if (!status.exists || !status.looksInitialized) {
  const answer = (await ask("No initialized profile. Open headed Chromium for manual login? [y/N] ")).toLowerCase();
  if (answer === "y" || answer === "yes") {
    const script = fileURLToPath(new URL("./manual-session.js", import.meta.url));
    const child = spawn(process.execPath, [script], { stdio: "inherit" });
    child.on("exit", (code) => { process.exitCode = code ?? 1; });
  } else {
    console.log("Run npm run auth:setup when ready.");
  }
  process.exit(0);
}

let context;
try {
  context = await launchPersistentSession({ headless: false });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1800);
  let state = await inspectSignedInState(page);

  if (state !== "signed_in") {
    console.log("\nA valid signed-in session could not be confirmed. Complete login manually in the visible browser.");
    await page.goto("https://x.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
    await ask("After completing login and seeing your signed-in X account, press Enter here...");
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1800);
    state = await inspectSignedInState(page);
    if (state === "unknown") {
      const confirmation = (await ask("The UI detector is uncertain. Do you visibly see your signed-in Home timeline? Type YES to confirm: ")).toUpperCase();
      if (confirmation === "YES") state = "user_confirmed";
    }
  }

  if (state === "signed_in" || state === "user_confirmed") {
    console.log("\nSession check passed. The local Chromium profile will be reused by the collector.");
  } else {
    console.error("\nSession was not confirmed. Complete login manually and run npm run auth:check again.");
    process.exitCode = 1;
  }
} catch (error) {
  console.error("Session preflight failed: " + error.message);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
}
