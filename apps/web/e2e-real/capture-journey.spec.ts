import { expect, test } from "./fixtures";
import { ensureOwner, rail, signIn, signOut } from "./helpers";

/**
 * MU-00 trivial journey against the real API and a fresh database:
 * setup → login → capture "Buy milk" on Today → it appears in the Inbox → reload → still there.
 * Setup is the run's first step: `auth01-recovery.spec.ts` sorts earlier and performs it (with the
 * recovery-code screen), so here `ensureOwner` creates the owner only when nobody has yet (a run of
 * this file alone) and otherwise signs in.
 */
test("owner sets up, signs in, captures a task and finds it in the Inbox after a reload", async ({
  page,
}) => {
  await ensureOwner(page);

  // Exercise the real login path too: sign out, then sign in again.
  await signOut(page);
  await signIn(page);

  await page.getByLabel("Task title").fill("Buy milk");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByLabel("Task title")).toHaveValue("");

  await rail(page).getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("Buy milk")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("Buy milk")).toBeVisible();
});
