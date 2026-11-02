import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, ensureOwner } from "./helpers";

/**
 * MU-05 journey J5 — find anything (docs/ROADMAP.md, MU): press the palette shortcut, type part of a
 * note, task or project name; results from all three appear grouped; Enter opens; "new task/note/
 * project" works from the same box. Real API and a fresh database; the Search page uses the same
 * endpoint. Everything is keyboard driven, as the palette is meant to be.
 */
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const box = (page: Page) => palette(page).getByRole("combobox");

async function openPalette(page: Page, text: string) {
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  await box(page).fill(text);
}

test("J5: find notes, tasks and projects from anywhere, open them, and create from the same box", async ({
  page,
}) => {
  await ensureOwner(page);
  await apiCall(page, "POST", "/api/notes", {
    path: "j5/quokka-habitat.md",
    content: "# Quokka habitat\n\nScrub and wetlands.\n",
  });
  await apiCall(page, "POST", "/api/notes", {
    path: "j5/unrelated.md",
    content: "# Unrelated\n\nMentions marsupials only in the body.\n",
  });
  await apiCall(page, "POST", "/api/projects", { name: "J5 Quokka reserve" });
  await apiCall(page, "POST", "/api/tasks", { title: "J5 feed the quokka", status: "next" });

  // Grouped results from all three kinds; a word in a note's body is found too.
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await openPalette(page, "quok");
  await expect(palette(page).getByRole("group", { name: "Notes" })).toBeVisible();
  await expect(palette(page).getByRole("option", { name: /quokka-habitat/ })).toBeVisible();
  await expect(palette(page).getByRole("group", { name: "Tasks" })).toBeVisible();
  await expect(palette(page).getByRole("option", { name: /J5 feed the quokka/ })).toBeVisible();
  await expect(palette(page).getByRole("group", { name: "Projects" })).toBeVisible();
  await box(page).fill("marsup");
  await expect(palette(page).getByRole("option", { name: /unrelated/ })).toBeVisible();

  // Keyboard: arrows select, Enter opens. A project opens its page.
  await box(page).fill("quokka reserve");
  await expect(palette(page).getByRole("option", { name: /J5 Quokka reserve/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(page.getByRole("heading", { name: "J5 Quokka reserve" })).toBeVisible();

  // A task opens the task detail (here from the project page: the shortcut works anywhere).
  await openPalette(page, "feed the quok");
  await expect(palette(page).getByRole("option", { name: /J5 feed the quokka/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog", { name: "Task details" });
  await expect(detail.getByLabel("Title")).toHaveValue("J5 feed the quokka");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // A note opens in Notes (deep link), and survives a reload.
  await openPalette(page, "habitat");
  await expect(palette(page).getByRole("option", { name: /quokka-habitat/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/notes\?open=/);
  await expect(page.getByTitle("Revision 1").filter({ hasText: "j5/quokka-habitat.md" })).toBeVisible();
  await page.reload();
  await expect(page.getByTitle("Revision 1").filter({ hasText: "j5/quokka-habitat.md" })).toBeVisible();

  // Esc closes and gives focus back; commands: go to a view, toggle the theme.
  await openPalette(page, "go to tas");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tasks$/);
  const before = await page.locator("html").getAttribute("data-theme");
  await openPalette(page, "toggle");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", before ?? "");
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();

  // Create from the same box: nothing is created by Enter alone; ArrowDown picks the entry.
  await openPalette(page, "J5 brand new idea");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(palette(page).getByRole("option", { name: /New task/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Task details" }).getByLabel("Title")).toHaveValue(
    "J5 brand new idea",
  );
  await page.keyboard.press("Escape");

  await openPalette(page, "j5/created note");
  await palette(page).getByRole("option", { name: /New note/ }).click();
  await expect(page.getByTitle("Revision 1").filter({ hasText: "j5/created note.md" })).toBeVisible();

  await openPalette(page, "J5 Fresh project");
  await palette(page).getByRole("option", { name: /New project/ }).click();
  await expect(page.getByRole("heading", { name: "J5 Fresh project" })).toBeVisible();
  const sidebar = page.getByRole("list", { name: "Active projects" });
  await expect(sidebar.getByRole("link", { name: "J5 Fresh project" })).toBeVisible();

  // A server validation error is shown verbatim and the palette stays open.
  await openPalette(page, "../escape");
  await palette(page).getByRole("option", { name: /New note/ }).click();
  await expect(palette(page).getByRole("alert")).toHaveText("path traversal is not allowed");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");

  // The Search page answers from the same endpoint; the text lives in the URL.
  await page.goto("/search?q=quokka");
  await expect(page.getByRole("heading", { name: "Notes", level: 2 })).toBeVisible();
  const results = page.getByRole("main");
  await expect(results.getByRole("link", { name: "Quokka habitat" })).toBeVisible();
  await expect(results.getByRole("link", { name: "J5 Quokka reserve" })).toBeVisible();
  await page.getByRole("button", { name: "J5 feed the quokka" }).click();
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("searchbox").fill("zzzznothing");
  await expect(page.getByText("Nothing matches “zzzznothing”.")).toBeVisible();
  await expect(page).toHaveURL(/q=zzzznothing/);
});
