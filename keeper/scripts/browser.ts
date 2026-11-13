import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/** Chromium from the Playwright cache, or CHROMIUM_PATH. */
export function chromiumPath(): string {
  const p = process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
  if (!existsSync(p)) throw new Error(`Chromium not found at ${p}; set CHROMIUM_PATH`);
  return p;
}

export function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: chromiumPath(), headless: true });
}
