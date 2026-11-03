import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  apiCall,
  ensureOwner,
  expectNoteSaved,
  noteEditor,
  noteFileBytes,
  noteSaveState,
  writeNoteFile,
} from "./helpers";

/**
 * UX-06 — live preview (ADR-0056), against the real API, a throwaway database and a real notes
 * directory. Live mode is decorations only: these specs are the evidence that what is typed or
 * ticked in it reaches the `.md` file as exactly the bytes expected, that links open the right
 * note, that nothing a note says can run, and that the conflict flow is the one Source has.
 */
interface Note {
  id: string;
  path: string;
  content: string;
}

const create = (page: Page, path: string, content: string) =>
  apiCall<Note>(page, "POST", "/api/notes", { path, content });

const modeButton = (page: Page, name: "Source" | "Live") =>
  page.getByRole("group", { name: "Editor mode" }).getByRole("button", { name, exact: true });

async function chooseMode(page: Page, mode: "Source" | "Live") {
  await modeButton(page, mode).click();
  await expect(modeButton(page, mode)).toHaveAttribute("aria-pressed", "true");
}

const fileText = async (rel: string) => (await noteFileBytes(rel)).toString("utf8");

test("Live is the default for a new browser; the choice is remembered and Source stays available", async ({
  page,
}) => {
  await ensureOwner(page);
  const note = await create(page, "ux06/mode.md", "# Mode\n\nSome **bold** text.\n");
  await page.evaluate(() => localStorage.removeItem("atlas-notes-mode"));
  await page.goto(`/notes?open=${note.id}`);
  await expect(modeButton(page, "Live")).toHaveAttribute("aria-pressed", "true");
  await expect(modeButton(page, "Source")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".cm-live-strong")).toHaveText("bold");
  await expect(noteEditor(page)).not.toContainText("**bold**");

  await chooseMode(page, "Source");
  await expect(page.locator(".cm-live-strong")).toHaveCount(0);
  await expect(noteEditor(page)).toContainText("**bold**");
  await page.reload();
  await expect(modeButton(page, "Source")).toHaveAttribute("aria-pressed", "true");
  await expect(noteEditor(page)).toContainText("**bold**");
  await chooseMode(page, "Live");
  await page.reload();
  await expect(modeButton(page, "Live")).toHaveAttribute("aria-pressed", "true");
  // The editor stays a textbox with the same name in both modes.
  await expect(page.getByRole("textbox", { name: "Note content" })).toBeVisible();
});

test("typing in Live mode reaches the file with exactly the bytes typed; switching mode keeps the cursor", async ({
  page,
}) => {
  await ensureOwner(page);
  const original = "# Live typing\n\nSee [[ux06/Target]] and **bold** text.\n\n- [ ] first\n";
  const note = await create(page, "ux06/typing.md", original);
  await create(page, "ux06/Target.md", "# Target\n");
  await page.goto(`/notes?open=${note.id}`);
  await chooseMode(page, "Live");
  await expectNoteSaved(page);

  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  // Markup typed in Live mode is stored as typed; multi-byte characters stay UTF-8.
  const typed = "\nünï ✓ 日本語 𝄞 😀 **typed bold** `code` [[ux06/Target|alias]] #tag\ntrailing  ";
  await page.keyboard.type(typed, { delay: 40 });
  await expectNoteSaved(page);
  await expect.poll(() => fileText("ux06/typing.md")).toBe(`${original}${typed}`);
  expect(Buffer.compare(await noteFileBytes("ux06/typing.md"), Buffer.from(`${original}${typed}`, "utf8"))).toBe(0);

  // Mode switches keep the text and the cursor: type, switch, type again at the same place.
  await page.keyboard.type(" AAA");
  await chooseMode(page, "Source");
  await noteEditor(page).focus();
  await page.keyboard.type("BBB");
  await chooseMode(page, "Live");
  await noteEditor(page).focus();
  await page.keyboard.type("CCC");
  await expectNoteSaved(page);
  await expect.poll(() => fileText("ux06/typing.md")).toBe(`${original}${typed} AAABBBCCC`);

  // Undo works across the switches: all three insertions go, one run of typing at a time.
  await page.keyboard.press("Control+z");
  await expect.poll(() => fileText("ux06/typing.md")).not.toContain("CCC");
});

test("ticking a checkbox edits the text, saves, survives a reload and shows in Source", async ({ page }) => {
  await ensureOwner(page);
  const note = await create(page, "ux06/tasks.md", "# Tasks\n\n- [ ] first\n- [x] second\n  - [ ] nested\n");
  await page.goto(`/notes?open=${note.id}`);
  await chooseMode(page, "Live");
  await expectNoteSaved(page);

  const boxes = page.locator(".cm-live-checkbox");
  await expect(boxes).toHaveCount(3);
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await boxes.nth(0).click();
  await expectNoteSaved(page);
  await expect.poll(() => fileText("ux06/tasks.md")).toBe("# Tasks\n\n- [x] first\n- [x] second\n  - [ ] nested\n");
  await boxes.nth(1).click();
  await expect.poll(() => fileText("ux06/tasks.md")).toBe("# Tasks\n\n- [x] first\n- [ ] second\n  - [ ] nested\n");

  await page.reload();
  await expect(page.locator(".cm-live-checkbox").nth(0)).toBeChecked();
  await expect(page.locator(".cm-live-checkbox").nth(1)).not.toBeChecked();
  // Ctrl+Z reverts the last tick through the normal change path.
  await noteEditor(page).click();
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => fileText("ux06/tasks.md")).not.toBe("# Tasks\n\n- [x] first\n- [ ] second\n  - [ ] nested\n");
  await chooseMode(page, "Source");
  await expect(noteEditor(page)).toContainText("- [");
});

test("a [[wiki link]] opens its note on click; an unknown one does nothing; the source line shows the brackets", async ({
  page,
}) => {
  await ensureOwner(page);
  await create(page, "ux06/Target note.md", "# Target note\n");
  const note = await create(
    page,
    "ux06/Links.md",
    "# Links\n\nOne line first.\n\nSee [[ux06/Target note|the target]] and [[ux06/nothing]].\n",
  );
  await page.goto(`/notes?open=${note.id}`);
  await chooseMode(page, "Live");
  await expect(noteEditor(page)).toContainText("See the target and ux06/nothing.");

  await page.locator(".cm-live-unresolved").click();
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "ux06/Links.md" })).toBeVisible();

  await page.locator(".cm-live-wikilink:not(.cm-live-unresolved)").click();
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "ux06/Target note.md" })).toBeVisible();
  // The file the click came from is unchanged.
  expect(await fileText("ux06/Links.md")).toBe(
    "# Links\n\nOne line first.\n\nSee [[ux06/Target note|the target]] and [[ux06/nothing]].\n",
  );
});

test("the line with the cursor shows its Markdown, the others render", async ({ page }) => {
  await ensureOwner(page);
  const note = await create(page, "ux06/lines.md", "# Heading\n\nfirst **one**\n\nsecond **two**\n");
  await page.goto(`/notes?open=${note.id}`);
  await chooseMode(page, "Live");
  await noteEditor(page).locator(".cm-line", { hasText: "second two" }).click();
  await expect(noteEditor(page)).toContainText("second **two**");
  await expect(noteEditor(page)).toContainText("first one");
  await expect(noteEditor(page)).not.toContainText("# Heading");
  // Keyboard: moving the cursor up reveals that line instead.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(noteEditor(page)).toContainText("first **one**");
  await expect(noteEditor(page)).toContainText("second two");
  // Every character stays reachable: Home/End and arrows work through revealed syntax.
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expectNoteSaved(page);
  await expect.poll(() => fileText("ux06/lines.md")).toBe("# Heading\n\nfirst **one**!\n\nsecond **two**\n");
});

test("note text cannot run anything or open an unsafe link in Live mode", async ({ page }) => {
  await ensureOwner(page);
  const hostile = [
    "# Hostile",
    "",
    "[click](javascript:window.__pwned=1) [[javascript:window.__pwned=2]]",
    "",
    '<img src=x onerror="window.__pwned=3"> <script>window.__pwned=4</script>',
    "",
    "![i](https://example.invalid/tracker.png) <a href=\"javascript:window.__pwned=5\">x</a>",
    "",
    "[ok](https://example.com)",
    "",
  ].join("\n");
  const note = await create(page, "ux06/hostile.md", hostile);
  const opened: string[] = [];
  await page.addInitScript(() => {
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
    (window as unknown as { __opened: string[] }).__opened = [];
  });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("dialog", (dialog) => void dialog.dismiss());
  await page.goto(`/notes?open=${note.id}`);
  await chooseMode(page, "Live");
  await expect(noteEditor(page)).toContainText("click");

  const dom = await page.locator('[data-testid="note-editor"]').evaluate((root) => ({
    elements: root.querySelectorAll("script,iframe,object,embed,a,form,img[src],style,svg").length,
    bad: [...root.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes]
        .filter((a) => /^on/i.test(a.name) || /javascript:|vbscript:|data:text\/html/i.test(a.value))
        .map((a) => `${el.tagName}.${a.name}`),
    ),
  }));
  expect(dom).toEqual({ elements: 0, bad: [] });
  expect(requests.filter((url) => url.includes("example.invalid"))).toEqual([]);

  // Ctrl+click on the hostile link and on the safe one: only https opens, in a new tab, never javascript:.
  await page.getByText("click", { exact: true }).click({ modifiers: ["Control"] });
  await page.getByText("ok", { exact: true }).click({ modifiers: ["Control"] });
  const calls = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(calls).toEqual(["https://example.com/"]);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(opened).toEqual([]);
  expect(await fileText("ux06/hostile.md")).toBe(hostile);
});

test("a file edited on disk while typing in Live mode is a conflict: nothing is overwritten", async ({ page }) => {
  await ensureOwner(page);
  const note = await create(page, "ux06/conflict.md", "# Conflict\n\n- [ ] item\n");
  await page.goto(`/notes?open=${note.id}`);
  await chooseMode(page, "Live");
  await expectNoteSaved(page);

  const theirs = "# Conflict\n\nedited by another program\n";
  await writeNoteFile("ux06/conflict.md", theirs);
  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("my own words");
  await expect(noteSaveState(page)).toHaveAttribute("data-save-state", "conflict");
  await expect(page.getByText(/Nothing was overwritten/)).toBeVisible();
  await expect(noteEditor(page)).toContainText("my own words");
  expect(await fileText("ux06/conflict.md")).toBe(theirs);

  // A checkbox ticked during the conflict changes only the local text; the file is still theirs.
  await page.keyboard.type(" and more");
  await page.waitForTimeout(1500);
  expect(await fileText("ux06/conflict.md")).toBe(theirs);

  await page.getByRole("button", { name: "Reload server version" }).click();
  await expect(noteEditor(page)).toContainText("edited by another program");
  await expect(noteEditor(page)).not.toContainText("my own words");
  await expectNoteSaved(page);
  expect(await fileText("ux06/conflict.md")).toBe(theirs);
});

test("trailing spaces, tabs and front matter come back from Live mode byte for byte", async ({ page }) => {
  await ensureOwner(page);
  const original = "---\ntitle: Odd\ntags: [a, b]\n---\n# Odd\n\ntrailing  \n- [ ] a\n\ttabbed\n";
  const note = await create(page, "ux06/odd.md", original);
  await page.goto(`/notes?open=${note.id}`);
  await chooseMode(page, "Live");
  await expect(noteEditor(page)).toContainText("trailing");
  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("end");
  await expectNoteSaved(page);
  await expect.poll(() => fileText("ux06/odd.md")).toBe(`${original}end`);
  // Tick the box: only the one character between the brackets changes.
  await page.locator(".cm-live-checkbox").click();
  await expect.poll(() => fileText("ux06/odd.md")).toBe(`${original.replace("[ ]", "[x]")}end`);
});
