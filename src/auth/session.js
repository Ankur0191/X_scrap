import { chromium } from "playwright";
import { profileDir } from "./profile.js";

export async function launchPersistentSession({ headless = false } = {}) {
  return chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1440, height: 960 },
    acceptDownloads: false
  });
}

export async function inspectSignedInState(page) {
  const currentPath = new URL(page.url()).pathname;
  if (/\/login|\/i\/flow\/login/i.test(currentPath)) return "signed_out";

  const signedInSelectors = [
    '[data-testid="AppTabBar_Profile_Link"]',
    '[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="SideNav_AccountSwitcher_Button"]'
  ];
  for (const selector of signedInSelectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 1200 })) return "signed_in";
    } catch { /* selector may not exist in this X layout */ }
  }

  const signInLink = page.getByRole("link", { name: /^(sign in|log in)$/i }).first();
  try {
    if (await signInLink.isVisible({ timeout: 800 })) return "signed_out";
  } catch { /* accessible label may change */ }

  return "unknown";
}
