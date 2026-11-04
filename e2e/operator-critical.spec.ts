import { expect, test } from "@playwright/test";
import path from "node:path";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("Browser error:", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("Browser console:", message.text()); });
  await page.addInitScript({ path: path.resolve("e2e/tauri-mock.js") });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Preparing Wordlyte…")).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Workspaces" })).toBeVisible();
});

test("stages a service item and commits it on air", async ({ page }) => {
  const cockpitEntry = page.getByText("John 3:16").last();
  await cockpitEntry.click();
  await expect(page.getByText("Staged", { exact: true })).toBeVisible();
  await page.getByRole("complementary").getByRole("button", { name: "Go Live", exact: true }).click();

  await expect(page.getByText("On Air", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__WORDLYTE_E2E__.live?.data?.book)).toBe("John");
});

test("does not consume a one-shot service item when send-live fails", async ({ page }) => {
  await page.getByRole("button", { name: /Service Plan/ }).click();
  await page.getByRole("button", { name: /Keep after playing/ }).click();
  await page.evaluate(() => { window.__WORDLYTE_E2E__.failNextSend = true; });

  await page.getByRole("button", { name: "Play Next" }).first().click();
  await expect(page.getByRole("button", { name: "Play Next" }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__WORDLYTE_E2E__.live)).toBeNull();

  await page.getByRole("button", { name: "Play Next" }).first().click();
  await expect(page.getByText(/Schedule is empty/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__WORDLYTE_E2E__.live?.data?.verse)).toBe(16);
});

declare global {
  interface Window {
    __WORDLYTE_E2E__: {
      live: any;
      failNextSend: boolean;
    };
  }
}
