import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  await expect(
    page.getByRole("heading", { name: "Create your Atlas account" }),
  ).toBeVisible();
  await page.getByLabel("Name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your Atlas account" }),
  ).toBeHidden();
}

/** Sign in through the real login form. */
export async function signIn(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Sign in to Atlas" }),
  ).toBeVisible();
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to Atlas" }),
  ).toBeHidden();
}

/** The shell's icon rail (UX-02): Today, Inbox, Tasks, Projects, Notes and Settings. */
export function rail(page: Page) {
  return page.getByRole("navigation", { name: "Destinations" });
}

/** Open a Settings section from the section list (UX-08). */
export async function openSettingsSection(page: Page, name: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name, exact: true })
    .click();
  await expect(page.getByRole("heading", { name, level: 2, exact: true })).toBeVisible();
}

/** The button that opens the command palette (the sidebar's Search row). */
export function searchButton(page: Page) {
  return page.getByRole("button", { name: "Search", exact: true });
}

/** Sign out via the shell's button. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
}

/**
 * Make sure the owner exists and the page is signed in, whichever journey runs first. All journeys
 * share one database per run, so the first to start creates the owner and the rest sign in.
 */
export async function ensureOwner(page: Page): Promise<void> {
  await page.goto("/");
  const setup = page.getByRole("heading", {
    name: "Create your Atlas account",
  });
  const login = page.getByRole("heading", { name: "Sign in to Atlas" });
  const today = page.getByRole("heading", { name: "Today" });
  await expect(setup.or(login).or(today).first()).toBeVisible();
  if (await setup.isVisible()) {
    await createOwner(page);
  } else if (await login.isVisible()) {
    await signIn(page);
  }
  // The rail on a wide screen, the bottom nav on a phone (UX-02).
  await expect(
    page
      .getByRole("navigation", { name: /^(Destinations|Bottom navigation)$/ })
      .getByRole("link", { name: "Inbox" }),
  ).toBeVisible();
}

/**
 * Call the real API as the signed-in owner (cookie session + CSRF double submit), for journey
 * set-up and read-back that the UI does not offer yet (for example creating a project, MU-02).
 */
export async function apiCall<T = unknown>(
  page: Page,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = document.cookie.match(/(?:^|;\s*)atlas_csrf=([^;]+)/)?.[1];
      const response = await fetch(path, {
        method,
        credentials: "include",
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(csrf ? { "X-CSRF-Token": decodeURIComponent(csrf) } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!response.ok)
        throw new Error(`${method} ${path} → ${response.status}`);
      return response.status === 204 ? null : response.json();
    },
    { method, path, body },
  );
}

/** A local calendar date (`YYYY-MM-DD`) in `timeZone`, `days` from today. */
export function dateIn(timeZone: string, days = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

/** The task detail panel (UX-04). */
export function taskPanel(page: Page) {
  return page.getByRole("dialog", { name: "Task details" });
}

/** A property's value button in the task detail ("Priority High", "Status Inbox", …). */
export function taskProperty(page: Page, name: string) {
  return taskPanel(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });
}

/** Choose a value of a menu property (status, priority, project); it saves by itself. */
export async function chooseTaskProperty(page: Page, name: string, option: string) {
  await taskProperty(page, name).click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
}

/** The Tasks page's filter bar (UX-07). */
export function filterBar(page: Page) {
  return page.getByRole("search", { name: "Task filters" });
}

/** Choose a value of a filter chip (Status, Priority, Project, Sort); it is applied to the URL at once. */
export async function chooseFilter(page: Page, chip: string, option: string) {
  await filterBar(page).getByRole("button", { name: new RegExp(`^${chip}\\b`) }).click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
}

/** Open the Due chip's popover (named "Due date"); Esc or a press outside closes it. */
export async function openDueFilter(page: Page) {
  await filterBar(page).getByRole("button", { name: /^Due\b/ }).click();
  const dialog = page.getByRole("dialog", { name: "Due date" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Pick a time zone through the searchable list (Enter takes the best match or the typed name). */
export async function chooseTimeZone(page: Page, query: string) {
  await taskProperty(page, "Time zone").click();
  const search = page.getByRole("combobox", { name: "Search time zones" });
  await search.fill(query);
  const exact = page.getByRole("option", { name: query, exact: true });
  const typed = page.getByRole("option", { name: `Use “${query}”` });
  await exact.or(typed).first().click();
}

/** Autosave settled: the header indicator says Saved (there is no Save button since UX-04). */
export async function expectTaskSaved(page: Page) {
  await expect(taskPanel(page).locator("[data-save-state]")).toHaveAttribute(
    "data-save-state",
    "saved",
  );
}

/** The notes directory of this run's API (global setup creates it; notes are plain files in it). */
export function notesDir(): string {
  const dir = process.env.ATLAS_E2E_NOTES_DIR;
  if (!dir) throw new Error("ATLAS_E2E_NOTES_DIR is not set — global setup did not run");
  return dir;
}

/** The exact bytes of a note's file on disk. */
export const noteFileBytes = (rel: string) => readFile(path.join(notesDir(), rel));

/** Write a note's file directly, the way an external editor would. */
export const writeNoteFile = (rel: string, text: string) =>
  writeFile(path.join(notesDir(), rel), text, "utf8");

/** The open note's save indicator (UX-05). */
export function noteSaveState(page: Page) {
  return page.locator(".notes-header [data-save-state]");
}

/** Autosave settled: the header says Saved (there is no Save button since UX-05). */
export async function expectNoteSaved(page: Page) {
  await expect(noteSaveState(page)).toHaveAttribute("data-save-state", "saved");
}

/** Make sure the links/details panel is showing (its default depends on the screen width). */
export async function openNoteDetails(page: Page) {
  const toggle = page.getByRole("button", { name: "Links and details" });
  // On a phone (UX-11) the toolbar has no details button: it is the first item of "Note options".
  if ((await toggle.count()) === 0) {
    await page.getByRole("button", { name: "Note options" }).click();
    await page.getByRole("menuitem", { name: "Show links and details" }).click();
    await expect(page.getByRole("region", { name: "Note details" })).toBeVisible();
    return;
  }
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(page.getByRole("region", { name: "Note details" })).toBeVisible();
}

/** Choose an entry of the open note's "…" menu. */
export async function noteMenu(page: Page, item: string) {
  await page.getByRole("button", { name: "Note options" }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** The note's CodeMirror text area. */
export function noteEditor(page: Page) {
  return page.getByTestId("note-editor").locator(".cm-content");
}
