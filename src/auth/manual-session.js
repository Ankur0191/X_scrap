import { chromium } from "playwright";
import { profileDir } from "./profile.js";

console.log("Launching a persistent, headed Chromium profile.");
console.log("Sign in manually only for your own account. This project will not extract or export cookies.");
console.log("Close the browser window when done; your local browser profile remains on this machine.");
let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 960 },
    args: ["--start-maximized"]
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://x.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("X login page opened. Complete login manually; do not share credentials.");
  await new Promise((resolve) => context.on("close", resolve));
} catch (error) {
  console.error("Could not launch Chromium:", error.message);
  process.exitCode = 1;
} finally {
  if (context) {
    try { await context.close(); } catch { /* already closed */ }
  }
}
