import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "./fixtures";
import { apiCall, dateIn, ensureOwner } from "./helpers";

/**
 * MU-07 journey J6 — Today as home, the daily note and templates (docs/ROADMAP.md, MU). Real API,
 * real notes directory, fresh database. The browser's zone is far ahead of UTC on purpose: the
 * daily note must be named for the viewer's calendar day, not the server's.
 *
 * Also checks the Markdown rules: the daily note and the note made from a template are plain
 * `.md` files on disk, opening today's note again never rewrites it, template text is untrusted
 * (only {{date}} and {{title}} are replaced) and server messages are shown as they are.
 */
const ZONE = "Pacific/Kiritimati";
test.use({ timezoneId: ZONE, locale: "en-GB" });

const notesDir = () => {
  const dir = process.env.ATLAS_E2E_NOTES_DIR;
  if (!dir)
    throw new Error(
      "ATLAS_E2E_NOTES_DIR is not set — global setup did not run",
    );
  return dir;
};
const onDisk = (rel: string) => readFile(path.join(notesDir(), rel), "utf8");

test("J6: Today is home, today's note is created once, notes start from a template", async ({
  page,
}) => {
  const today = dateIn(ZONE);
  const task = (title: string, fields: Record<string, unknown>) =>
    apiCall(page, "POST", "/api/tasks", {
      title,
      status: "next",
      time_zone: ZONE,
      ...fields,
    });

  await ensureOwner(page);
  await task("J6 overdue", { due_at: `${dateIn(ZONE, -2)}T09:00:00` });
  await task("J6 due today", { due_at: `${today}T23:30:00` });
  await task("J6 scheduled", { start_at: `${today}T10:00:00` });
  const template = await apiCall<{ id: string }>(page, "POST", "/api/notes", {
    path: "templates/J6 meeting.md",
    content:
      "# {{title}}\n\nDate: {{date}}\n\n{{time}} {{ title }} <b>raw</b>\n",
  });

  // Today is the home page and lists the day's work and an empty events slot.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  const section = (name: string) =>
    page.getByRole("heading", { name }).locator("..");
  await expect(section("Overdue").getByText("J6 overdue")).toBeVisible();
  await expect(section("Due today").getByText("J6 due today")).toBeVisible();
  await expect(
    section("Scheduled today").getByText("J6 scheduled"),
  ).toBeVisible();
  const events = page.getByRole("region", { name: "Events" });
  await expect(events).toContainText("once a calendar is connected");
  await expect(events.getByRole("listitem")).toHaveCount(0);

  // No note yet; creating it opens a plain Markdown file named for the viewer's day.
  const card = page.getByRole("region", { name: "Daily note" });
  await expect(card).toContainText("No note for today yet.");
  await card.getByRole("button", { name: "Create today's note" }).click();
  await expect(page.getByText(`daily/${today}.md · revision 1`)).toBeVisible();
  expect(await onDisk(`daily/${today}.md`)).toBe(`# ${today}\n`);

  // Write in it and save, then come back through Today: the card previews it as text.
  const editor = page.getByTestId("note-editor").locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nJ6 wrote <b>this</b> today\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(`daily/${today}.md · revision 2`)).toBeVisible();
  await page.goto("/");
  await expect(card.getByText("J6 wrote <b>this</b> today")).toBeVisible();
  await expect(card.locator("b")).toHaveCount(0);

  // Opening it again, from the card and from the palette, never rewrites it.
  await card.getByRole("button", { name: "Open today's note" }).click();
  await expect(page.getByText(`daily/${today}.md · revision 2`)).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("open today's");
  await palette.getByRole("option", { name: /Open today's note/ }).click();
  await expect(page.getByText(`daily/${today}.md · revision 2`)).toBeVisible();
  const saved = await onDisk(`daily/${today}.md`);
  expect(saved).toContain("J6 wrote <b>this</b> today");
  expect(
    (
      await apiCall<{ notes: { path: string }[] }>(
        page,
        "GET",
        "/api/notes?folder=daily",
      )
    ).notes,
  ).toHaveLength(1);

  // New note from a template, reached from the palette. Only {{date}} and {{title}} are replaced.
  await page.keyboard.press("Control+k");
  await palette.getByRole("combobox").fill("from template");
  await palette.getByRole("option", { name: /New note from template/ }).click();
  const picker = page.getByRole("combobox", { name: "Template" });
  await expect(picker).toBeFocused();
  await picker.selectOption(template.id);
  await page.getByLabel("New note or folder path").fill("j6/Standup");
  await page.getByRole("button", { name: "New from template" }).click();
  await expect(page.getByText("j6/Standup.md · revision 1")).toBeVisible();
  const expected = `# Standup\n\nDate: ${today}\n\n{{time}} Standup <b>raw</b>\n`;
  expect(await onDisk("j6/Standup.md")).toBe(expected);

  // Creating over an existing note is refused with the server's message and changes nothing.
  await page.getByLabel("New note or folder path").fill("j6/Standup");
  await page.getByRole("button", { name: "New from template" }).click();
  await expect(
    page.getByText("A note or folder already exists there"),
  ).toBeVisible();
  expect(await onDisk("j6/Standup.md")).toBe(expected);
});
