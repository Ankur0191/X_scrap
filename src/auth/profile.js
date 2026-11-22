import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "../..");
export const profileDir = path.join(projectRoot, ".local", "browser-profile");

export function profileStatus() {
  const exists = fs.existsSync(profileDir);
  let entries = [];
  if (exists) {
    try { entries = fs.readdirSync(profileDir); } catch { /* permission issue handled by caller */ }
  }
  return {
    exists,
    looksInitialized: entries.some((name) => ["Default", "Local State", "SingletonLock"].includes(name)),
    path: profileDir
  };
}
