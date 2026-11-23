import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchPersistentSession, inspectSignedInState } from "./session.js";

let context;
const rl = readline.createInterface({ input, output });
try {
  console.log("Opening X in headed Chromium with a persistent local profile.");
  console.log("Sign in manually. Do not paste passwords, cookies, or verification codes into the terminal.");
  context = await launchPersistentSession({ headless: false });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://x.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });

  const browserClosed = new Promise((resolve) => context.once("close", () => resolve("closed")));
  const userFinished = rl.question("After login, navigate to Home and press Enter here...")
    .then(() => "finished")
    .catch(() => "closed");
  const result = await Promise.race([browserClosed, userFinished]);

  if (result === "finished") {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    const state = await inspectSignedInState(page);
    console.log("Session check: " + state);
    if (state === "signed_out") process.exitCode = 1;
    else if (state === "unknown") console.log("UI state was inconclusive; run npm run auth:check for manual confirmation.");
  }
  console.log("Persistent profile is stored locally under .local/browser-profile/ and excluded from Git.");
} catch (error) {
  console.error("Could not complete manual session setup: " + error.message);
  process.exitCode = 1;
} finally {
  rl.close();
  if (context) await context.close();
}
