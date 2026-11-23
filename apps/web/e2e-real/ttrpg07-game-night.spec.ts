import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, ensureOwner } from "./helpers";

/**
 * TTRPG-07 game-night journey (docs/TTRPG_MODULE_PLAN.md, "Game-night acceptance"), in a real
 * browser against the real API and PostgreSQL. The monster catalogue is blocked by the harness
 * (`TTRPG_SRD_BASE_URL` points at a closed port), so cards are made by hand.
 *
 * Create a campaign and session, add the fighter and companion, prepare an ambush with a book
 * reference, several goblin slots and one override, run the fight with physical initiative rolls,
 * refresh midway, undo a damage action, spend a party resource, pause across a "session", resume
 * and finish, start a second fight and see the party carry forward, check the handoff, and switch
 * the module off and on.
 */
test.use({ timezoneId: "Europe/Stockholm", locale: "en-GB" });
test.describe.configure({ mode: "serial" });

const CAMPAIGN = "Lost Mine of Phandelver";

async function axe(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  const found = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 4),
  }));
  expect(found, `axe violations on ${label}`).toEqual([]);
}

async function campaignId(page: Page): Promise<string> {
  const list = await apiCall<{ items: { id: string; title: string }[] }>(page, "GET", "/api/ttrpg/campaigns");
  const found = list.items.find((c) => c.title === CAMPAIGN);
  if (!found) throw new Error("campaign missing");
  return found.id;
}

test("the module is off by default and appears only after it is switched on", async ({ page }) => {
  await ensureOwner(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "TTRPG" })).toHaveCount(0);
  await page.goto("/ttrpg");
  await expect(page.getByText("This module is off.")).toBeVisible();
  const direct = await apiCall<unknown>(page, "GET", "/api/ttrpg/campaigns").catch((err: Error) => err.message);
  expect(String(direct)).toContain("404");

  await page.goto("/settings/plugins");
  const toggle = page.getByRole("switch", { name: /TTRPG/ });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(nav.getByRole("link", { name: "TTRPG" })).toBeVisible();
  await axe(page, "Settings > Plugins");
  // enablement alone creates nothing
  await page.goto("/ttrpg");
  await expect(page.getByText("No campaigns yet.", { exact: false })).toBeVisible();
});

test("create the campaign, the party and the creature cards", async ({ page }) => {
  await ensureOwner(page);
  await page.goto("/ttrpg");
  await page.getByLabel("Title").fill(CAMPAIGN);
  await page.getByLabel(/Book/).fill("Lost Mine of Phandelver (2014 booklet)");
  await page.getByRole("button", { name: "Create campaign" }).click();
  await page.getByRole("link", { name: CAMPAIGN }).click();
  await expect(page.getByRole("heading", { name: CAMPAIGN })).toBeVisible();
  await expect(page.locator('a[href^="/notes?open="]').first()).toBeVisible();

  // the fighter, with a limited-use resource
  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Brenna");
  await page.getByLabel("Level").fill("3");
  await page.getByLabel("AC", { exact: true }).fill("17");
  await page.getByLabel("Max HP").fill("28");
  await page.getByLabel("Initiative modifier").fill("1");
  await page.getByRole("button", { name: "Add resource" }).click();
  await page.getByLabel("Resource 1 name").fill("Second Wind");
  await page.getByLabel("Resource 1 recovers on").selectOption("short");
  await page.getByRole("button", { name: "Add to party" }).click();
  await expect(page.getByRole("heading", { name: /Brenna/ })).toBeVisible();

  // the companion
  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Sildar Hallwinter");
  await page.getByLabel("Role").selectOption("companion");
  await page.getByLabel("AC", { exact: true }).fill("15");
  await page.getByLabel("Max HP").fill("20");
  await page.getByRole("button", { name: "Add to party" }).click();
  await expect(page.getByRole("heading", { name: /Sildar/ })).toBeVisible();
  await expect(page.getByText(/HP 28\/28|HP .*28.*\/28/).first()).toBeVisible();

  // creature cards by hand; the blocked catalogue fails cleanly and leaves them working
  await page.goto("/ttrpg/creatures");
  await page.getByLabel("Search the SRD").fill("goblin");
  await page.locator("#main-content").getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Manual creature cards still work");
  await page.getByRole("button", { name: "New creature" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Goblin");
  await page.getByLabel("AC", { exact: true }).fill("15");
  await page.getByLabel("HP", { exact: true }).fill("7");
  await page.getByLabel("Initiative modifier").fill("2");
  await page.getByRole("button", { name: "Create creature" }).click();
  await expect(page.getByRole("button", { name: "Goblin", exact: true })).toBeVisible();
  await axe(page, "creature library");
});

test("prepare the ambush: book reference, three goblins, one override, a launch link", async ({ page }) => {
  await ensureOwner(page);
  const cid = await campaignId(page);
  await page.goto(`/ttrpg/${cid}`);
  await page.getByLabel("New encounter").fill("Goblin ambush");
  await page.getByRole("button", { name: "Prepare encounter" }).click();
  await page.getByRole("link", { name: "Goblin ambush" }).click();
  await expect(page.getByRole("heading", { name: "Goblin ambush" })).toBeVisible();

  await page.getByLabel("Book reference", { exact: true }).fill("p. 6, Goblin Arrows");
  await page.getByRole("button", { name: "Save book reference" }).click();
  await page.getByLabel("Session", { exact: true }).selectOption({ label: "1. Session 01" });
  for (const name of ["Brenna", "Sildar Hallwinter"]) {
    // a controlled checkbox: it flips when the server has answered, so click and then look
    const box = page.getByRole("checkbox", { name });
    await expect(box).toBeEnabled();
    await box.click();
    await expect(box).toBeChecked();
  }

  await page.getByLabel("Creature").selectOption({ label: "Goblin (AC 15, HP 7)" });
  await page.getByLabel("How many").fill("3");
  await page.getByRole("button", { name: "Add from card" }).click();
  await expect(page.getByLabel("Name of Goblin 3")).toBeVisible();
  // the first goblin is tougher at this table
  await page.getByLabel("HP of Goblin 1").fill("12");
  await page.getByRole("button", { name: "Save Goblin 1" }).click();
  await expect(page.getByText(/set by hand: hp/)).toBeVisible();

  await page.getByRole("button", { name: "Add to session note" }).click();
  await expect(page.getByText("Link added under Prep in the session note.")).toBeVisible();
  await axe(page, "encounter prep");

  // the link works from the note: open the session note's preview and follow it
  const detail = await apiCall<{ sessions: { note: { note_id: string } }[] }>(page, "GET", `/api/ttrpg/campaigns/${cid}`);
  const note = await apiCall<{ content: string }>(page, "GET", `/api/notes/${detail.sessions[0].note.note_id}`);
  expect(note.content).toContain("- Encounter: [Goblin ambush](/ttrpg/encounters/");
});

test("run the fight: initiative, refresh midway, undo, resource, pause and resume, finish", async ({ page }) => {
  await ensureOwner(page);
  const cid = await campaignId(page);
  await page.goto(`/ttrpg/${cid}`);
  await page.getByRole("link", { name: "Goblin ambush" }).click();
  await page.getByRole("button", { name: "Launch encounter" }).click();
  await expect(page).toHaveURL(/\/ttrpg\/runs\//);
  await expect(page.getByRole("heading", { name: "Initiative" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start the fight" })).toBeDisabled();

  // physical rolls, including zero and a negative total, and a tie
  const rolls: Record<string, string> = {
    Brenna: "18",
    "Sildar Hallwinter": "10",
    "Goblin 1": "10",
    "Goblin 2": "0",
    "Goblin 3": "-1",
  };
  for (const [name, total] of Object.entries(rolls)) {
    await page.getByLabel(`Initiative for ${name}`).fill(total);
  }
  await expect(page.getByText("Ties: choose who acts first")).toBeVisible();
  await page.getByRole("button", { name: "Move Goblin 1 earlier" }).click();
  await axe(page, "run setup");
  await page.getByRole("button", { name: "Start the fight" }).click();
  await expect(page.getByRole("status").first()).toContainText("Round 1: Brenna's turn");

  // damage, undo it, and spend a party resource
  await page.getByLabel("Amount for Brenna").fill("9");
  await page.getByRole("button", { name: "Damage Brenna" }).click();
  const history = page.locator(".ttrpg-history");
  await expect(history.getByText("Brenna took 9 (HP 28 → 19)")).toBeVisible();
  await page.getByRole("button", { name: /^Undo: Brenna took 9/ }).click();
  await expect(history.getByText("Brenna took 9 (HP 28 → 19) (undone)")).toBeVisible();
  await page.getByLabel("Amount for Brenna").fill("6");
  await page.getByRole("button", { name: "Damage Brenna" }).click();
  await page.getByRole("button", { name: "Spend Second Wind (Brenna)" }).click();
  await page.getByLabel("Amount for Goblin 2").fill("7");
  await page.getByRole("button", { name: "Damage Goblin 2" }).click();
  await page.getByRole("button", { name: "Next turn" }).click();
  // the tie at 10 was settled by hand: Goblin 1 acts before Sildar
  await expect(page.getByRole("status").first()).toContainText("Round 1: Goblin 1's turn");
  await page.getByRole("button", { name: "Next turn" }).click();
  await expect(page.getByRole("status").first()).toContainText("Round 1: Sildar Hallwinter's turn");

  // a refresh midway recovers the same fight
  await page.reload();
  await expect(page.getByRole("status").first()).toContainText("Round 1: Sildar Hallwinter's turn");
  await expect(page.getByText("Second Wind: 0/1 left")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Undo: Round 1: Sildar/ })).toBeVisible();
  await axe(page, "run in progress");

  // pause, leave, and find the unfinished fight from the campaign page
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("status").first()).toContainText("Paused.");
  await expect(page.getByRole("button", { name: "Next turn" })).toBeDisabled();
  await page.goto(`/ttrpg/${cid}`);
  await expect(page.getByText(/A fight is not finished/)).toBeVisible();
  await page.getByRole("link", { name: "Goblin ambush" }).first().click();
  await expect(page.getByRole("status").first()).toContainText("Paused.");
  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByRole("button", { name: "Next turn" }).click();

  await page.getByLabel(/How did it end/).fill("Two goblins fled, Klarg's lookout was caught.");
  await page.getByRole("button", { name: "End the fight" }).click();
  await expect(page.getByRole("status").first()).toContainText("Ended: Two goblins fled");
});

test("a second fight carries the party forward; the next session opens with the handoff", async ({ page }) => {
  await ensureOwner(page);
  const cid = await campaignId(page);
  // the DM writes where to pick up in the session note
  const detail = await apiCall<{ sessions: { id: string; note: { note_id: string } }[] }>(page, "GET", `/api/ttrpg/campaigns/${cid}`);
  const note = await apiCall<{ id: string; content: string; revision: number }>(page, "GET", `/api/notes/${detail.sessions[0].note.note_id}`);
  await apiCall(page, "PUT", `/api/notes/${note.id}`, {
    content: note.content.replace("## Next session\n", "## Next session\n\nFollow the wagon tracks to Cragmaw Hideout.\n"),
    base_revision: note.revision,
  });

  await page.goto(`/ttrpg/${cid}`);
  await page.getByRole("link", { name: "Goblin ambush" }).click();
  await page.getByRole("button", { name: "Launch encounter" }).click();
  await expect(page.getByRole("heading", { name: "Initiative" })).toBeVisible();
  // party state carried forward; the goblins start fresh
  await expect(page.getByText(/AC 17 · HP 22\/28/)).toBeVisible();
  await expect(page.getByText(/AC 15 · HP 7\/7/).first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel this fight" }).click();
  await expect(page.getByRole("status").first()).toContainText("Ended");

  // the next session opens with the handoff
  await page.goto(`/ttrpg/${cid}`);
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByRole("button", { name: /2\. Session 02/ }).click();
  await expect(page.getByLabel("Where we left off")).toContainText("Follow the wagon tracks to Cragmaw Hideout.");
  await axe(page, "campaign page");
});

test("a second tab sees a change made in the first without reloading", async ({ page, context }) => {
  await ensureOwner(page);
  const cid = await campaignId(page);
  const encounters = await apiCall<{ items: { id: string }[] }>(page, "GET", `/api/ttrpg/campaigns/${cid}/encounters`);
  const run = await apiCall<{ id: string; revision: number; combatants: { id: string; name: string }[] }>(
    page,
    "POST",
    `/api/ttrpg/campaigns/${cid}/runs`,
    { encounter_id: encounters.items[0].id },
  );
  const totals = Object.fromEntries(run.combatants.map((c, i) => [c.id, 20 - i]));
  const setup = await apiCall<{ revision: number }>(page, "PATCH", `/api/ttrpg/runs/${run.id}/setup`, {
    base_revision: run.revision,
    initiative: totals,
  });
  await apiCall(page, "POST", `/api/ttrpg/runs/${run.id}/start`, { base_revision: setup.revision });

  await page.goto(`/ttrpg/runs/${run.id}`);
  const other = await context.newPage();
  await other.goto(`/ttrpg/runs/${run.id}`);
  await expect(other.getByRole("status").first()).toContainText("Round 1:");
  const before = await other.getByRole("status").first().textContent();

  await page.getByRole("button", { name: "Next turn" }).click();
  await expect(page.getByRole("status").first()).not.toHaveText(before ?? "");
  // the other tab is idle and visible: it looks again by itself
  await expect(other.getByRole("status").first()).not.toHaveText(before ?? "", { timeout: 15000 });
  await other.close();
  await page.getByLabel(/How did it end/).fill("Test fight.");
  await page.getByRole("button", { name: "End the fight" }).click();
  await expect(page.getByRole("status").first()).toContainText("Ended");
});

test("a deleted session note can be repaired by linking another note", async ({ page }) => {
  await ensureOwner(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const cid = await campaignId(page);
  const detail = await apiCall<{ sessions: { id: string; title: string; note: { note_id: string } }[] }>(
    page,
    "GET",
    `/api/ttrpg/campaigns/${cid}`,
  );
  const session = detail.sessions[detail.sessions.length - 1];
  await apiCall(page, "POST", "/api/notes", { path: "Elsewhere/Replacement session.md", content: "# Replacement\n" });
  await apiCall(page, "DELETE", `/api/notes/${session.note.note_id}`);
  await page.goto(`/ttrpg/${cid}`);
  await expect(page.getByText("Note missing")).toBeVisible();
  await page.getByRole("button", { name: "Link another note" }).click();
  await page.getByLabel("Note to link").selectOption({ label: "Elsewhere/Replacement session.md" });
  await page.getByRole("button", { name: "Link this note" }).click();
  await expect(page.getByText("Note missing")).toHaveCount(0);
  await expect(page.locator('a[href^="/notes?open="]', { hasText: "Replacement" })).toBeVisible();
  await axe(page, "campaign page after repair");
});

test("the rules reference works on its own page and from a condition in a fight", async ({ page }) => {
  await ensureOwner(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Rules" }).click();
  await expect(page.getByRole("heading", { name: "Rules reference", level: 1 })).toBeVisible();
  await page.getByLabel("Search the rules").fill("three-quarters");
  await expect(page.getByText("Cover", { exact: true })).toBeVisible();
  await expect(page.getByText(/\+5 bonus to AC and Dexterity saving throws/)).toBeVisible();
  await expect(page.getByText(/System Reference Document 5\.1/).first()).toBeVisible();
  await axe(page, "rules reference");
  // a link to one rule opens it
  await page.goto("/ttrpg/rules?rule=prone");
  await expect(page.getByText(/only movement option is to crawl/)).toBeVisible();

  // inside a fight: a condition opens its rule beside the tracker
  const cid = await campaignId(page);
  const encounters = await apiCall<{ items: { id: string }[] }>(page, "GET", `/api/ttrpg/campaigns/${cid}/encounters`);
  const run = await apiCall<{ id: string; revision: number; combatants: { id: string; name: string }[] }>(
    page, "POST", `/api/ttrpg/campaigns/${cid}/runs`, { encounter_id: encounters.items[0].id });
  const totals = Object.fromEntries(run.combatants.map((c, i) => [c.id, 20 - i]));
  const setup = await apiCall<{ revision: number }>(page, "PATCH", `/api/ttrpg/runs/${run.id}/setup`, { base_revision: run.revision, initiative: totals });
  const started = await apiCall<{ revision: number; combatants: { id: string; name: string; party_member_id: string | null; party_revision: number | null }[] }>(
    page, "POST", `/api/ttrpg/runs/${run.id}/start`, { base_revision: setup.revision });
  const npc = started.combatants.find((c) => !c.party_member_id)!;
  await apiCall(page, "POST", `/api/ttrpg/runs/${run.id}/actions`, { kind: "add_condition", combatant_id: npc.id, condition: "poisoned", base_revision: started.revision, mutation_key: "rules-e2e-poisoned-0001" });
  await page.goto(`/ttrpg/runs/${run.id}`);
  await page.getByRole("button", { name: "Read the rule for poisoned" }).click();
  await expect(page.locator('[data-pane="rules"]').getByText(/disadvantage on attack rolls and ability checks/)).toBeVisible();
  await axe(page, "fight with the rules pane");
  await page.getByLabel(/How did it end/).fill("Rules test.");
  await page.getByRole("button", { name: "End the fight" }).click();
  await expect(page.getByRole("status").first()).toContainText("Ended");
});

test("on a phone the notes and the combat tracker switch without losing what was typed", async ({ page }) => {
  await ensureOwner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const cid = await campaignId(page);
  await page.goto(`/ttrpg/${cid}`);
  await page.getByRole("link", { name: "Goblin ambush" }).click();
  await page.getByRole("button", { name: "Launch encounter" }).click();
  await expect(page.getByRole("heading", { name: "Initiative" })).toBeVisible();

  const switcher = page.getByRole("group", { name: "Show" });
  await expect(switcher).toBeVisible();
  await expect(switcher.getByRole("button", { name: "Combat" })).toHaveAttribute("aria-pressed", "true");
  await switcher.getByRole("button", { name: "Notes" }).click();
  const editor = page.locator(".ttrpg-play-notes .cm-content");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nGoblin tracks lead north.");
  await switcher.getByRole("button", { name: "Combat" }).click();
  await expect(page.getByRole("heading", { name: "Initiative" })).toBeVisible();
  await expect(editor).toBeHidden();
  await switcher.getByRole("button", { name: "Notes" }).click();
  await expect(editor).toContainText("Goblin tracks lead north.");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await switcher.getByRole("button", { name: "Combat" }).click();
  await axe(page, "run on a phone");
  await page.getByRole("button", { name: "Cancel this fight" }).click();
});

test("every TTRPG page fits and passes axe at phone, tablet and desktop widths", async ({ page }) => {
  await ensureOwner(page);
  const cid = await campaignId(page);
  const encounters = await apiCall<{ items: { id: string }[] }>(page, "GET", `/api/ttrpg/campaigns/${cid}/encounters`);
  const paths = ["/ttrpg", `/ttrpg/${cid}`, `/ttrpg/encounters/${encounters.items[0].id}`, "/ttrpg/creatures", "/settings/plugins"];
  for (const size of [
    { width: 360, height: 740 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    for (const path of paths) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const offenders =
        overflow > 0
          ? await page.evaluate(() =>
              [...document.querySelectorAll("#main-content *")]
                .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
                .slice(0, 6)
                .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
            )
          : [];
      expect(overflow, `${path} at ${size.width}px overflows sideways: ${offenders.join(", ")}`).toBeLessThanOrEqual(0);
      await axe(page, `${path} at ${size.width}px`);
    }
  }
});

test("switching the module off hides it and keeps the campaign; switching on restores it", async ({ page }) => {
  await ensureOwner(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const cid = await campaignId(page);
  await page.goto("/settings/plugins");
  await page.getByRole("switch", { name: /TTRPG/ }).click();
  await expect(page.getByRole("switch", { name: /TTRPG/ })).not.toBeChecked();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "TTRPG" })).toHaveCount(0);
  await page.goto(`/ttrpg/${cid}`);
  await expect(page.getByText("This module is off.")).toBeVisible();
  // a full export still holds the campaign: disabling hides the module, never the data
  const exported = await page.evaluate(async () => {
    const response = await fetch("/api/export", { credentials: "include" });
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  });
  expect(exported.status).toBe(200);
  expect(exported.bytes).toBeGreaterThan(1000);
  await page.goto("/settings/plugins");
  await page.getByRole("switch", { name: /TTRPG/ }).click();
  await expect(page.getByRole("switch", { name: /TTRPG/ })).toBeChecked();
  await page.goto(`/ttrpg/${cid}`);
  await expect(page.getByRole("heading", { name: CAMPAIGN })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Brenna/ })).toBeVisible();
});
