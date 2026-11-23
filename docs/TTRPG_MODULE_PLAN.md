# Atlas TTRPG module implementation plan

**Status:** Planned. This document is the implementation handoff. Read [AGENTS.md](../AGENTS.md) and the [roadmap](ROADMAP.md) first. Reconcile the delivery sequence below with the current milestone, track implementation task status in the roadmap, and record actual verification in [ACCEPTANCE.md](ACCEPTANCE.md). Confirm proposed integration points against the current checkout before writing code.

## Product goal

Run a published adventure with the book, physical dice, and Atlas. Atlas handles session notes, party state, encounter prep, and live combat. The first preset is D&D 5e (2014), exercised with one DM, one player running a fighter, and a companion in the original Lost Mine of Phandelver. The module ships empty apart from generic templates and any properly attributed SRD data. Adventure prose, maps, and proprietary stat blocks stay in the user's book and private notes.

Version one is DM-operated. Adventure generation, a virtual tabletop, player accounts or views, full character sheets, automated balancing, additional rulesets, and combat while disconnected from the Atlas server are deferred.

## User workflow

1. Enable **Settings → Plugins → TTRPG**. Create a campaign, pick its note folder, and optionally enter the book title and rules preset. Create a campaign home and first session note. Enablement alone creates no campaign or notes.
2. Add the fighter and companion to **Party**. Open the session note and enter a book reference, brief prep, and one or more encounter links. Add NPC and location notes when needed.
3. Prepare encounters using imported SRD creatures or manual cards. Pick party participants, set enemy counts, and adjust combatants and starting stats for this table.
4. Open the session and launch a prepared encounter or improvise one. Enter physical initiative results. Keep the notes and tracker visible together on wide screens. Offer a simple Notes/Combat switch on narrow screens that preserves work in progress.
5. Pause and resume as needed. At the end of a fight, optionally record an outcome. At the end of the session, capture where to pick up. The next session opens with that handoff and any unfinished fight remains resumable.

## Module boundaries

| Area | Owns | Integrates through |
| --- | --- | --- |
| Feature registration | Default-off setting, route and navigation visibility, effective enablement | Existing Atlas settings, authentication, and app shell |
| Campaigns and sessions | Campaign metadata, session history, note associations, book references | Existing note creation, folder, link, and revision APIs |
| Party | Reusable character cards and durable play state | Typed party commands shared by roster and combat views |
| Creatures | Canonical local cards, import provenance, source adapters | A small search/fetch adapter for the 2014 SRD source and manual entry |
| Encounter preparation | Reusable lineups, per-encounter overrides, source snapshots | Party references and local creature cards |
| Combat | Runs, initiative roster, turns, actions, undo and outcomes | A transaction boundary that includes affected party state |
| Rules preset | 2014 labels, condition choices and optional rest calculations | Small pure functions or configuration exercised by domain tests |

Keep FastAPI routes, workflows, persistence, provider DTOs, and React screens scoped to the feature. Put turn and HP calculations in testable domain logic. Use existing authentication, API schema generation, migrations, note services, and shell components. Keep generic Atlas internals free of campaign and rules knowledge. A small registration point is sufficient for this bundled plugin. Runtime loading of third-party code is outside this plan.

The disabled state hides entry points and blocks feature operations server-side, including direct route access and source calls. The setting remains available for re-enabling. Disabling preserves both structured data and notes. Migrations can run using normal Atlas deployment regardless of enablement. Scope reads and writes to the authenticated owner and validate campaign membership of referenced entities.

## Notes and structured records

Use real Markdown files for user prose. A minimal campaign contains a home note and a first note under `Sessions/`. Session templates have **Where we left off**, **Book references**, **Prep**, **During play**, and **Next session**. `NPCs/` and `Locations/` grow as needed. Book references are free text, so the DM can use the pagination or room labels in their copy.

Use PostgreSQL for structured feature records. Suggested entities and ownership follow. Match names and representations to existing project conventions.

| Record | Data and lifecycle |
| --- | --- |
| Campaign | Owner, title, rules preset, optional book title, home note ID, archive state. |
| Session | Campaign, note ID, title/date or sequence, status. The note owns the written handoff. Show the prior note or its handoff when starting the next session. |
| Party member | Campaign, role, name, level when applicable, AC, max HP, speed, initiative modifier, passive Perception, attacks and abilities. Archive retired members so historical runs still resolve. |
| Party play state | Current and temporary HP, conditions, death-save marks when needed, and used/available resources. Has a revision. May change between fights. |
| Creature card | Owner, name, AC, HP, optional speed, initiative modifier, actions, traits and CR. Imported cards include source edition, external ID, and attribution. |
| Encounter definition | Campaign, title, optional book reference and setup reminder, associated session or location note, selected party IDs, and a reusable enemy/ally lineup with explicit overrides and copied stats. |
| Combat run | Campaign, starting session, optional source definition, status, initiative order, round, active combatant, revision, and optional outcome. History remains readable when the definition changes. |
| Combatant and action | Each roster slot has a stable run-local ID. NPCs own their run-local HP and conditions. Party slots reference party play state. The action record contains enough information to undo an eligible change and explain the result in history. |

Reference notes by Atlas note ID after checking the note identity API. Moving or renaming a linked note should preserve the association. If a note is deleted, expose the missing link and allow relinking. Keep combat history accessible. Scaffold notes via the existing note service and handle partial failures across PostgreSQL and the Markdown filesystem. Retrying campaign creation must avoid duplicate notes or overwriting a note the user edited.

## Catalog and encounter prep

Use the [D&D 5e SRD API](https://docs.dnd5eapi.co/api/get-list-of-monsters-with-optional-filtering) at `/api/2014/monsters`. Fetch the index for local name search and fetch details when importing a result. Normalize provider data into Atlas cards and retain provenance. Include the attribution required by [SRD 5.1](https://media.wizards.com/2023/downloads/dnd/SRD_CC_v5.1.pdf) alongside imported material. Verify the provider's terms and dataset provenance before bundling any catalog data. Keep imported text safely rendered and limit network access to the configured provider routes with bounded timeouts. Send only catalog requests to the provider. Campaign names, notes, and player records stay on Atlas.

Manual cards work with a name, AC, and HP at minimum. Allow duplication of a card into an editable variant. Encounter definitions snapshot enemy and temporary ally stats, and runs snapshot their starting lineup. Existing encounters remain playable during catalog errors, and upstream edits affect an encounter only through an explicit refresh of its prep. Prepare multiple independent slots from one card and allow per-slot names and starting HP. Starting a fresh run resets enemies and initiative and reads the party's existing state.

## Combat behavior

- **Start:** Create a run in initiative setup. Enter totals, including zero or negative totals, sort, and set ties manually. Support an improvised encounter from the current session and manual combatants.
- **Advance:** Start at round one, highlight the active turn, and increment the round when wrapping. Skip removed or defeated combatants. A party member at zero HP remains eligible for their turn unless the DM removes them. Define a stable next turn when an active combatant is removed and a clear end state if nobody is eligible.
- **Edit:** Apply HP changes, use temporary HP when applying damage, and allow direct corrections. Track conditions, optional expiry reminders, and limited-use resources. Let the DM mark death saves. Show actions, AC, and HP alongside initiative. Add reinforcements or reorder the roster during combat.
- **Rest:** Provide manual party edits and a short/long rest confirmation that previews affected HP or resources using the preset and configured reset behavior. Let the DM override the preview. Rest editing remains available between fights.
- **Persist:** Save each confirmed action. Reload should recover the same round, actor, initiative, HP, and conditions. Show failure state and preserve unsaved input. Support pause across sessions, resume, and end with a short outcome.
- **Concurrency:** Use the existing optimistic concurrency conventions where applicable. Send an expected revision and a unique mutation key for retryable actions. Check affected party revisions as well as the run revision. Commit run, party, and action history together. A stale client refreshes instead of overwriting newer state. Use at most one unfinished run per campaign for v1.
- **Undo:** Undo the most recent reversible combat action using stored before/after state. Restore party effects in the same transaction. If a separate edit has superseded the affected state, keep the newer state and show that the undo conflicts. Ending clears the active run, but keeps its history and the final party state.

## Delivery sequence and acceptance criteria

All stages are planned. Implement focused vertical slices and keep the feature off by default throughout development.

| ID | Depends on | Deliverable and verification |
| --- | --- | --- |
| TTRPG-01 | Current Atlas integration points confirmed | Register the feature setting and shell route. Test default-off on both existing and fresh accounts, protected direct access, and retention after toggling. |
| TTRPG-02 | 01 | Campaign and sessions linked through the note service. Test creation, retry after partial scaffold failure, note move, missing-note repair, and ownership checks. |
| TTRPG-03 | 02 | Party reference cards and persistent play state. Test validation, concurrent edits, resources, manual corrections, and confirmed rest adjustments. |
| TTRPG-04 | 02 | Manual cards and one SRD adapter with source information. Use recorded fixtures or a fake provider for successful import, timeout, malformed payload, and repeat import. Keep external calls out of CI. |
| TTRPG-05 | 03, 04 | Prepared encounters and note launch links. Verify overrides, repeated monsters, custom entries, and snapshot stability after catalog edits. |
| TTRPG-06 | 05 | Initiative, combat actions, undo, history, pause and resume. Test round wrap, ties, removal of active actors, independent monster HP, party carry-over, refresh recovery, duplicate retries, and conflicting edits from another tab. |
| TTRPG-07 | 06 | Restore and export verification, mobile layout and accessibility, and the complete DM journey. Document the feature, attribution, and release limits. |

Use the repository's verification gate, regenerate and commit the TypeScript API schema when the backend contract changes, and record consequential decisions or outstanding risks in the existing project docs. Verify that normal backups restore Markdown plus structured campaign state, including paused combat. Check full export includes a readable, versioned representation of structured campaign data if the normal export does not already carry it. Keep the desktop and mobile shells on the shared UI and test supported layouts.

### Game-night acceptance

Create a campaign and session for the original Phandelver booklet. Add the fighter and companion, then prepare an ambush using a book reference, multiple goblin slots, and one manual override. Block the external monster API and run the fight with physical initiative rolls. Refresh midway and check recovery, undo a damage action, spend a party resource, and pause the fight across sessions. Resume and finish it. Start a second fight and verify that the party carries forward HP, conditions, and spent resources, while the new enemies start fresh. Confirm the next session opens with the written handoff and that disabling and re-enabling the plugin preserves the campaign.
