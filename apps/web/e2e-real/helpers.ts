import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

/**
 * Credentials for the owner created by {@link createOwner}. `example.com` is used on purpose: the
 * server rejects reserved domains such as `.test` (the form now shows why). The password is a throwaway value for the disposable per-run database.
 */
export const OWNER = {
  name: "Journey Owner",
  email: "owner@example.com",
  password: "journey-test-password-1",
};

/** Create the owner through the real first-run setup form (which also signs the owner in). */
export async function createOwner(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create your Atlas account" })).toBeVisible();
  await page.getByLabel("Name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create your Atlas account" })).toBeHidden();
}

/** Sign in through the real login form. */
export async function signIn(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Sign in to Atlas" })).toBeVisible();
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Atlas" })).toBeHidden();
}

/** Sign out via the shell's button. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
}
