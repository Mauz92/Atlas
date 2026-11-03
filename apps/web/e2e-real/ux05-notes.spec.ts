import { expect, test } from "./fixtures";
import {
  apiCall,
  ensureOwner,
  expectNoteSaved,
  noteEditor,
  noteFileBytes,
  noteMenu,
  noteSaveState,
  openNoteDetails,
  writeNoteFile,
} from "./helpers";

/**
 * UX-05 — notes autosave and the notes workspace (ADR-0054), against the real API, a throwaway
 * database and a real notes directory. These specs are the evidence that removing the Save button
 * lost nothing: typing reaches the `.md` file byte for byte, survives reload and being offline, and
 * an edit made on disk meanwhile is a conflict that never overwrites the file.
 */
interface Note {
  id: string;
  path: string;
  revision: number;
  content: string;
}

const create = (page: import("@playwright/test").Page, path: string, content: string) =>
  apiCall<Note>(page, "POST", "/api/notes", { path, content });

const get = (page: import("@playwright/test").Page, id: string) =>
  apiCall<Note>(page, "GET", `/api/notes/${id}`);

test("typing saves by itself: one request at a time, exact UTF-8 bytes on disk, and it survives a reload", async ({
  page,
}) => {
  await ensureOwner(page);
  const note = await create(page, "ux05/typing.md", "# Typing\n");

  // Count the note PUTs and watch that two are never in flight together.
  let inFlight = 0;
  let overlapped = false;
  const puts: string[] = [];
  const isPut = (request: import("@playwright/test").Request) =>
    request.method() === "PUT" && new RegExp(`/api/notes/${note.id}$`).test(request.url());
  page.on("request", (request) => {
    if (!isPut(request)) return;
    puts.push(request.postData() ?? "");
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
  });
  const done = (request: import("@playwright/test").Request) => {
    if (isPut(request)) inFlight -= 1;
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);

  await page.goto(`/notes?open=${note.id}`);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  // Slow enough to cross several pauses, with characters that take more than one byte.
  const typed = "\nünï ✓ 日本語 — 𝄞 emoji 😀\nsecond line\n";
  await page.keyboard.type(typed, { delay: 120 });
  await expect(noteSaveState(page)).toHaveAttribute("data-save-state", /saving|saved|unsaved/);
  await expectNoteSaved(page);

  expect(overlapped, "two PUTs for one note were in flight at once").toBe(false);
  expect(puts.length).toBeGreaterThanOrEqual(1);
  // The file holds exactly what was there plus what was typed: no added front matter, no newline
  // changes, and the bytes are UTF-8.
  const expected = Buffer.from(`# Typing\n${typed}`, "utf8");
  expect(Buffer.compare(await noteFileBytes("ux05/typing.md"), expected)).toBe(0);
  expect((await get(page, note.id)).content).toBe(`# Typing\n${typed}`);

  // SYNC-04: every autosave is also a retained revision (the base a sync client's stale save is
  // merged against), and the newest one is exactly the text on disk.
  const history = await apiCall<{ revisions: { revision: number }[] }>(
    page,
    "GET",
    `/api/notes/${note.id}/history`,
  );
  expect(history.revisions.length).toBeGreaterThanOrEqual(2);
  const newest = await apiCall<{ content: string }>(
    page,
    "GET",
    `/api/notes/${note.id}/history/${history.revisions[0].revision}`,
  );
  expect(newest.content).toBe(`# Typing\n${typed}`);

  await page.reload();
  await expect(noteEditor(page)).toContainText("second line");
  await expectNoteSaved(page);
  expect(Buffer.compare(await noteFileBytes("ux05/typing.md"), expected)).toBe(0);
});

test("Ctrl+S just saves now, and switching notes sends the pending text first", async ({ page }) => {
  await ensureOwner(page);
  const first = await create(page, "ux05/first.md", "# First note\n");
  await create(page, "ux05/second.md", "# Second note\n");
  await page.goto(`/notes?open=${first.id}`);

  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("typed then Ctrl+S");
  await page.keyboard.press("Control+s");
  await expectNoteSaved(page);
  expect((await noteFileBytes("ux05/first.md")).toString("utf8")).toBe("# First note\ntyped then Ctrl+S");

  // Type and switch at once: nothing waits for the pause.
  await page.keyboard.type(" and more");
  await page.getByRole("button", { name: "Second note", exact: true }).click();
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "ux05/second.md" })).toBeVisible();
  await expect
    .poll(async () => (await noteFileBytes("ux05/first.md")).toString("utf8"))
    .toBe("# First note\ntyped then Ctrl+S and more");
  // Undo in the new note never reaches back into the old one.
  await noteEditor(page).click();
  await page.keyboard.press("Control+z");
  await expect(noteEditor(page)).toContainText("Second note");
});

test("typing offline is kept on this device, survives a reload and is sent once the server is reachable", async ({
  page,
  context,
}) => {
  await ensureOwner(page);
  const note = await create(page, "ux05/offline.md", "# Offline\n");
  await page.goto(`/notes?open=${note.id}`);
  await expectNoteSaved(page);

  await context.setOffline(true);
  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("typed while offline");
  await expect(noteSaveState(page)).toHaveAttribute("data-save-state", "offline");
  await expect(noteSaveState(page)).toHaveText("Offline — saved on this device");
  const draft = await page.evaluate(
    (id) => localStorage.getItem(`atlas:note-draft:${id}`),
    note.id,
  );
  expect(JSON.parse(draft ?? "{}")).toMatchObject({ content: "# Offline\ntyped while offline" });
  expect((await noteFileBytes("ux05/offline.md")).toString("utf8")).toBe("# Offline\n");

  // Back on the network, the open page sends it without a click.
  await context.setOffline(false);
  await expectNoteSaved(page);
  expect((await noteFileBytes("ux05/offline.md")).toString("utf8")).toBe("# Offline\ntyped while offline");

  // The harder case: offline typing, then the tab is closed (the page goes away while offline) and
  // opened again later on a working connection.
  await context.setOffline(true);
  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" + typed before leaving");
  await expect(noteSaveState(page)).toHaveAttribute("data-save-state", "offline");
  await page.goto("about:blank");
  await context.setOffline(false);
  expect((await noteFileBytes("ux05/offline.md")).toString("utf8")).toBe("# Offline\ntyped while offline");
  await page.goto(`/notes?open=${note.id}`);
  await expect(page.getByText(/Restored text you typed here/)).toBeVisible();
  await expectNoteSaved(page);
  await expect(noteEditor(page)).toContainText("typed while offline + typed before leaving");
  expect((await noteFileBytes("ux05/offline.md")).toString("utf8")).toBe(
    "# Offline\ntyped while offline + typed before leaving",
  );
  const stored = await page.evaluate((id) => localStorage.getItem(`atlas:note-draft:${id}`), note.id);
  expect(stored).toBeNull();
});

test("reloading right after typing loses nothing", async ({ page }) => {
  await ensureOwner(page);
  const note = await create(page, "ux05/reload.md", "# Reload\n");
  await page.goto(`/notes?open=${note.id}`);
  await expectNoteSaved(page);
  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("typed an instant before the reload");
  // Well inside the pause, so only the leave-the-page flush (or, failing that, the draft) can save it.
  await page.reload();
  await expect(noteEditor(page)).toContainText("typed an instant before the reload");
  await expectNoteSaved(page);
  await expect
    .poll(async () => (await noteFileBytes("ux05/reload.md")).toString("utf8"))
    .toBe("# Reload\ntyped an instant before the reload");
});

test("a file edited on disk while typing is a conflict: the file is never overwritten and both versions survive", async ({
  page,
}) => {
  await ensureOwner(page);
  const note = await create(page, "ux05/external.md", "# External\n");
  await page.goto(`/notes?open=${note.id}`);
  await expectNoteSaved(page);

  // Another program edits the file; Atlas has not looked yet.
  const theirs = "# External\nedited by another program\n";
  await writeNoteFile("ux05/external.md", theirs);

  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("my own words");
  await expect(noteSaveState(page)).toHaveAttribute("data-save-state", "conflict");
  await expect(page.getByText(/Nothing was overwritten/)).toBeVisible();
  // Our text is still in the editor, the file still holds the other program's version.
  await expect(noteEditor(page)).toContainText("my own words");
  expect((await noteFileBytes("ux05/external.md")).toString("utf8")).toBe(theirs);

  // More typing and a wait: nothing is sent.
  await page.keyboard.type(" and more");
  await page.waitForTimeout(2500);
  expect((await noteFileBytes("ux05/external.md")).toString("utf8")).toBe(theirs);

  // Keep mine as a copy: a separate conflict file holds our text; the original is still theirs.
  await page.getByRole("button", { name: "Keep my version as a copy" }).click();
  await expect(page.getByText(/Kept your version as/)).toBeVisible();
  await expectNoteSaved(page);
  await expect(noteEditor(page)).toContainText("edited by another program");
  expect((await noteFileBytes("ux05/external.md")).toString("utf8")).toBe(theirs);
  const listing = await apiCall<{ notes: { path: string; id: string }[] }>(page, "GET", "/api/notes?folder=ux05");
  const copy = listing.notes.find((candidate) => candidate.path.includes("(conflict"));
  expect(copy, "a conflict copy exists").toBeTruthy();
  expect((await noteFileBytes(copy!.path)).toString("utf8")).toBe("# External\nmy own words and more");

  // After the choice the note saves normally again, on the revision the server now holds.
  await noteEditor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("continued");
  await expectNoteSaved(page);
  expect((await noteFileBytes("ux05/external.md")).toString("utf8")).toBe(`${theirs}continued`);
});

test("reload server version drops my text; a stale draft from before reload is offered, never applied", async ({
  page,
}) => {
  await ensureOwner(page);
  const note = await create(page, "ux05/stale.md", "# Stale\n");
  await page.goto(`/notes?open=${note.id}`);
  await expectNoteSaved(page);

  // A draft typed on revision 1 sits on this device while the note moved on to a newer revision.
  await page.evaluate(
    ({ id }) =>
      localStorage.setItem(
        `atlas:note-draft:${id}`,
        JSON.stringify({ content: "# Stale\nmy old draft\n", baseRevision: 1, savedAt: Date.now() }),
      ),
    { id: note.id },
  );
  await apiCall(page, "PUT", `/api/notes/${note.id}`, { content: "# Stale\nnewer on the server\n", base_revision: 1 });
  await page.reload();
  await expect(noteSaveState(page)).toHaveAttribute("data-save-state", "conflict");
  await expect(noteEditor(page)).toContainText("my old draft");
  expect((await noteFileBytes("ux05/stale.md")).toString("utf8")).toBe("# Stale\nnewer on the server\n");

  await page.getByRole("button", { name: "Reload server version" }).click();
  await expectNoteSaved(page);
  await expect(noteEditor(page)).toContainText("newer on the server");
  await expect(noteEditor(page)).not.toContainText("my old draft");
  expect(await page.evaluate((id) => localStorage.getItem(`atlas:note-draft:${id}`), note.id)).toBeNull();
});

test("workspace: create, rename in place, move and delete from the tree; [[links]] open from the preview", async ({
  page,
}) => {
  await ensureOwner(page);
  await create(page, "ux05w/Target note.md", "# Target note\n");
  const source = await create(page, "ux05w/Source.md", "# Source\n\nSee [[ux05w/Target note]] and [[ux05w/nothing]].\n");
  await page.goto(`/notes?open=${source.id}`);
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "ux05w/Source.md" })).toBeVisible();

  // Preview: a [[link]] to a note is a link, an unknown one is plain text; clicking opens the note.
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.getByTestId("markdown-preview");
  await expect(preview.getByRole("link", { name: "ux05w/Target note" })).toBeVisible();
  await expect(preview.locator(".wikilink.unresolved")).toHaveText("ux05w/nothing");
  await preview.getByRole("link", { name: "ux05w/Target note" }).click();
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "ux05w/Target note.md" })).toBeVisible();
  await page.getByRole("button", { name: "Preview", exact: true }).click();

  // New note: an inline name box in the tree, no path field, no prompt.
  page.on("dialog", (dialog) => {
    expect(dialog.type(), "only the delete confirmation may use a native dialog").toBe("confirm");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByRole("textbox", { name: "New note name" }).fill("Fresh idea");
  await page.keyboard.press("Enter");
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "ux05w/Fresh idea.md" })).toBeVisible();
  await expect(noteEditor(page)).toBeFocused();
  expect((await noteFileBytes("ux05w/Fresh idea.md")).toString("utf8")).toBe("# Fresh idea\n");

  // Rename from the row menu, in place.
  await page.getByRole("button", { name: "Actions for Fresh idea" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("textbox", { name: "Rename Fresh idea" });
  await expect(rename).toHaveValue("Fresh idea");
  await rename.fill("Renamed idea");
  await page.keyboard.press("Enter");
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "ux05w/Renamed idea.md" })).toBeVisible();
  await expect.poll(() => noteFileBytes("ux05w/Renamed idea.md").then((b) => b.toString("utf8"))).toBe("# Fresh idea\n");

  // New folder, then move the note into it with the menu.
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByRole("textbox", { name: "New folder name" }).fill("sub");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "sub", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Actions for Fresh idea" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitemradio", { name: "ux05w/sub" }).click();
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "ux05w/sub/Renamed idea.md" })).toBeVisible();

  // Delete from the header menu: the file moves to the trash folder, never removed.
  await noteMenu(page, "Delete");
  await expect(page.getByText("Moved to trash")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fresh idea" })).toHaveCount(0);
  const remaining = await apiCall<{ notes: { path: string }[] }>(page, "GET", "/api/notes?folder=ux05w");
  expect(remaining.notes.map((n) => n.path).sort()).toEqual(["ux05w/Source.md", "ux05w/Target note.md"]);
});

test("layout: the editor fills the height and nothing scrolls sideways at 1440, 1024, 720 and 390 px", async ({
  page,
}) => {
  await ensureOwner(page);
  const note = await create(page, "ux05l/Layout.md", `# Layout\n\n${"A long line of text that wraps. ".repeat(40)}\n`);

  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [720, 900],
    [390, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(`/notes?open=${note.id}`);
    await expect(noteEditor(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    const box = await page.getByTestId("note-editor").boundingBox();
    expect(box!.height, `editor height at ${width}px`).toBeGreaterThan(height * 0.5);
  }

  // The shell's sidebar gives way on Notes at 1024 px; the notes tree stays.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`/notes?open=${note.id}`);
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
  await expect(page.getByRole("button", { name: "New note", exact: true })).toBeVisible();

  // Ctrl+Alt+B toggles the details panel and the choice is remembered.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/notes?open=${note.id}`);
  const panel = page.getByRole("region", { name: "Note details" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Control+Alt+b");
  await expect(panel).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Links and details" })).toHaveAttribute("aria-pressed", "false");
  await openNoteDetails(page);
  await expect(panel).toBeVisible();
});
