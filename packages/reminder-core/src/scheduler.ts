/**
 * The device scheduler (M8-04b; SYNC_PROTOCOL.md 14.4, 14.5).
 *
 * One idempotent pipeline, {@link Scheduler.reconcile}, does everything: it diffs what *should* be
 * armed or shown (the synced `reminder` entities, the local task state, the per-device settings,
 * the fired set) against what the OS holds, and issues only the differences. Every entry point
 * (app start, a pull that changed a reminder, a local edit, a clock jump, a 30 s desktop tick, a
 * settings change) calls it, so running it twice changes nothing.
 *
 * Guarantees the tests pin down: one notification per `reminderId + effectiveAt` per device across
 * restarts, reboots and app updates (the *fired* key is persisted **before** the port is asked to
 * show, so a crash loses a notification instead of duplicating it - for a reminder the safe side;
 * a port that merely rejects rolls the key back so the next run retries); nothing is shown for a
 * cancelled, completed, dismissed or locally re-dated reminder; a reminder missed while the device
 * was off or the permission was denied is caught up within the catch-up window; a device clock or
 * zone change never moves a fire instant (they are absolute), and no wall-clock arithmetic happens
 * here except the optional quiet-hours window.
 */

import { classify, activeOverlay, effectiveOf, isLive, type DesiredItem, type PlantedBugs } from "./desired.ts";
import { contentFor, summaryContent } from "./content.ts";
import { fireKey, hashKey, idFor } from "./ids.ts";
import type {
  ActionSink,
  Clock,
  IdSource,
  NotificationPort,
  ReminderSource,
  SchedulerLogger,
  SchedulerStore,
} from "./ports.ts";
import { silentLogger } from "./ports.ts";
import { afterQuietHours, localMinute } from "./quiet.ts";
import {
  DEFAULT_SETTINGS,
  emptyState,
  type FireKey,
  type NotifySettings,
  type ReconcileResult,
  type ReminderView,
  type SchedulerState,
  type SnoozePreset,
} from "./types.ts";

export interface SchedulerDeps {
  clock: Clock;
  port: NotificationPort;
  store: SchedulerStore;
  source: ReminderSource;
  actions: ActionSink;
  ids: IdSource;
  logger?: SchedulerLogger;
  /** Used when the store holds no state yet. */
  defaults?: Partial<NotifySettings>;
  /** Test-only defects, see {@link PlantedBugs}. Never set in production. */
  plantedBugs?: PlantedBugs;
}

/** A key is `reminderId:ISO`; reminder ids are UUIDs and contain no colon. */
function reminderIdOf(key: FireKey): string {
  return key.slice(0, key.indexOf(":"));
}

const OVERLAY_MAX_AGE_MS = 7 * 24 * 3_600_000;
const MINUTE = 60_000;

export class Scheduler {
  private state: SchedulerState | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SchedulerDeps) {}

  // --- entry points -------------------------------------------------------------------------

  /** The idempotent pipeline (see the file comment). Calls are serialised. */
  reconcile(): Promise<ReconcileResult> {
    return this.serial(() => this.runReconcile(false));
  }

  /** The 30 s desktop tick: the same pipeline, plus the heartbeat. */
  tick(): Promise<ReconcileResult> {
    return this.serial(() => this.runReconcile(true));
  }

  /** App start, reboot or an app update: re-arms from the persisted state (idempotent). */
  onBoot(): Promise<ReconcileResult> {
    return this.reconcile();
  }

  /** The device clock or zone changed (or the device woke): reconcile with catch-up. */
  onClockChange(): Promise<ReconcileResult> {
    return this.reconcile();
  }

  async settings(): Promise<NotifySettings> {
    return this.serial(async () => (await this.load()).settings);
  }

  /** Change the per-device settings; text already handed to the OS is rebuilt (content mode). */
  updateSettings(patch: Partial<NotifySettings>): Promise<ReconcileResult> {
    return this.serial(async () => {
      const state = await this.load();
      state.settings = { ...state.settings, ...patch };
      if (state.settings.firedRetentionMs <= state.settings.catchUpMs) {
        state.settings.firedRetentionMs = state.settings.catchUpMs * 2;
      }
      // A changed content mode needs no special case: an armed alarm whose recorded mode differs
      // from the current one is replaced by the reconcile below (the text is chosen at arm time).
      await this.deps.store.write(state);
      return this.runReconcile(false);
    });
  }

  /** Snooze on this device: an optimistic local alarm now, the action queued for the server. */
  snooze(reminderId: string, preset: SnoozePreset): Promise<boolean> {
    return this.serial(async () => {
      const state = await this.load();
      const view = (await this.deps.source.views()).find((v) => v.reminder.id === reminderId);
      if (!view || view.reminder.state !== "armed") return false;
      const now = this.deps.clock.now();
      const until =
        preset.kind === "seconds"
          ? now + preset.seconds * 1000
          : this.nextLocalMorning(now);
      return this.record(state, view, {
        kind: "snooze",
        until,
        action: { kind: "snooze", snooze: preset },
      });
    });
  }

  /** Dismiss on this device: nothing more is shown for this occurrence anywhere after sync. */
  dismiss(reminderId: string): Promise<boolean> {
    return this.serial(async () => {
      const state = await this.load();
      const view = (await this.deps.source.views()).find((v) => v.reminder.id === reminderId);
      if (!view || view.reminder.state !== "armed") return false;
      return this.record(state, view, { kind: "dismiss", until: null, action: { kind: "dismiss" } });
    });
  }

  /**
   * Show a test notification now and, on platforms with OS scheduling, arm one 60 s ahead to
   * exercise the scheduling path. Generic text only. Returns what was done.
   */
  async testNotification(): Promise<{ shownNow: boolean; scheduledAt: number | null }> {
    const { clock, port } = this.deps;
    const now = clock.now();
    const body = summaryContent(1);
    let scheduledAt: number | null = null;
    await port.show({ ...body, id: hashKey(`test-now:${now}`) });
    if (port.capabilities().osScheduling) {
      scheduledAt = now + 60_000;
      await port.schedule({ ...body, id: hashKey(`test-later:${scheduledAt}`), at: scheduledAt });
    }
    return { shownNow: true, scheduledAt };
  }

  /** Reminders armed but older than the catch-up window: listed, never pushed. */
  missed(): Promise<string[]> {
    return this.serial(async () => {
      const state = await this.load();
      const views = await this.deps.source.views();
      return classify(views, state, this.deps.clock.now(), this.deps.plantedBugs).missed.map(
        (m) => m.view.reminder.id,
      );
    });
  }

  /** A copy of the persisted state, for diagnostics and tests. */
  snapshot(): Promise<SchedulerState> {
    return this.serial(async () => structuredClone(await this.load()));
  }

  // --- internals ----------------------------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<SchedulerState> {
    if (this.state) return this.state;
    const stored = await this.deps.store.read();
    const state = stored ?? emptyState({ ...DEFAULT_SETTINGS, ...this.deps.defaults });
    if (this.deps.plantedBugs?.forgetFiredOnRestart) state.fired = {};
    this.state = state;
    return state;
  }

  private async persist(state: SchedulerState): Promise<void> {
    await this.deps.store.write(state);
  }

  private async record(
    state: SchedulerState,
    view: ReminderView,
    what: {
      kind: "snooze" | "dismiss";
      until: number | null;
      action: { kind: "snooze" | "dismiss"; snooze?: SnoozePreset };
    },
  ): Promise<boolean> {
    const actionId = this.deps.ids.uuid();
    const previous = state.overlays[view.reminder.id];
    state.overlays[view.reminder.id] = {
      kind: what.kind,
      until: what.until,
      baseRevision: view.reminder.revision,
      actionId,
      createdAt: this.deps.clock.now(),
    };
    await this.persist(state);
    try {
      await this.deps.actions.submit({
        actionId,
        reminderId: view.reminder.id,
        kind: what.action.kind,
        ...(what.action.snooze ? { snooze: what.action.snooze } : {}),
        baseRevision: view.reminder.revision,
        actedAt: this.deps.clock.now(),
      });
    } catch (error) {
      // The intent could not be queued: undo the local effect rather than pretend it will sync.
      if (previous) state.overlays[view.reminder.id] = previous;
      else delete state.overlays[view.reminder.id];
      await this.persist(state);
      throw error;
    }
    await this.runReconcile(false);
    return true;
  }

  /** Optimistic "tomorrow 09:00" in the device zone, replaced by the server's value on sync. */
  private nextLocalMorning(now: number): number {
    const { clock } = this.deps;
    let t = Math.floor(now / MINUTE) * MINUTE;
    for (let i = 0; i < 24 * 60 + 61 && localMinute(clock, t) !== 0; i++) t += MINUTE;
    for (let i = 0; i < 24 * 60 + 61 && localMinute(clock, t) !== 9 * 60; i++) t += MINUTE;
    return t;
  }

  private async runReconcile(isTick: boolean): Promise<ReconcileResult> {
    const { clock, port, source, logger = silentLogger } = this.deps;
    const bugs = this.deps.plantedBugs ?? {};
    const state = await this.load();
    const now = clock.now();
    const caps = port.capabilities();
    const settings = state.settings;
    const views = await source.views();
    const byId = new Map(views.map((v) => [v.reminder.id, v]));
    const pendingActions = new Set((await source.pendingActionIds?.()) ?? []);

    // Housekeeping: forget what can no longer matter.
    for (const [key, at] of Object.entries(state.fired)) {
      if (at < now - settings.firedRetentionMs) delete state.fired[key];
    }
    for (const [reminderId, overlay] of Object.entries(state.overlays)) {
      const view = byId.get(reminderId);
      const superseded =
        view !== undefined &&
        view.reminder.revision > overlay.baseRevision &&
        !pendingActions.has(overlay.actionId);
      if (!view || superseded || overlay.createdAt < now - OVERLAY_MAX_AGE_MS) {
        // Our own snooze was applied by the server (the revision moved by exactly that action)
        // after the optimistic alarm already showed: the server's instant is the same snooze, so
        // it must not notify a second time.
        if (
          view &&
          overlay.kind === "snooze" &&
          overlay.fired &&
          view.reminder.revision === overlay.baseRevision + 1 &&
          view.reminder.snoozedUntil !== null
        ) {
          state.fired[fireKey(reminderId, Date.parse(view.reminder.snoozedUntil))] = now;
        }
        delete state.overlays[reminderId];
      }
    }
    state.recentShows = state.recentShows.filter((t) => t > now - settings.burstWindowMs);
    if (isTick) state.lastTickAt = now;
    state.lastReconcileAt = now;

    const permission = await port.permission();
    const result: ReconcileResult = {
      permission,
      enabled: settings.enabled,
      armed: 0,
      scheduled: 0,
      cancelled: 0,
      shown: 0,
      deferredByCap: 0,
      exactAlarms: caps.exactAlarms,
      missed: [],
    };

    if (!settings.enabled || permission !== "granted") {
      // Nothing may fire. Nothing is marked fired either: granting later catches up.
      if (caps.osScheduling) {
        for (const p of await port.listPending()) {
          await port.cancel(p.id);
          result.cancelled += 1;
        }
        state.schedule = {};
      }
      await this.persist(state);
      return result;
    }

    // What the OS delivered while we were not looking is fired: never show it again.
    for (const id of await port.delivered()) {
      const key = state.ids[String(id)];
      if (key === undefined) continue;
      if (state.fired[key] === undefined) state.fired[key] = now;
      delete state.schedule[key];
      const reminderId = reminderIdOf(key);
      state.shown[reminderId] = { key, id };
      this.markOverlayFired(state, reminderId, key);
    }

    const { desired, missed } = classify(views, state, now, bugs);
    result.missed = missed.map((m) => m.view.reminder.id);

    // Quiet hours defer the *alarm*, not the key.
    const at = (item: DesiredItem) => afterQuietHours(clock, settings.quietHours, item.effective);
    const due: DesiredItem[] = [];
    const future: DesiredItem[] = [];
    for (const item of desired) (at(item) <= now ? due : future).push(item);

    if (caps.osScheduling) await this.armAlarms(state, future, at, caps.maxPending, result, bugs);

    if (bugs.skipCatchUp) {
      const fresh = due.filter((d) => d.effective >= now - 2 * MINUTE);
      due.length = 0;
      due.push(...fresh);
    }
    const replaced = await this.fireDue(state, due, now, result);

    // Withdraw what is on screen for a reminder that no longer wants it (dismissed, snoozed or
    // completed elsewhere, cancelled, locally re-dated).
    const stale: number[] = [...replaced];
    for (const [reminderId, shown] of Object.entries(state.shown)) {
      const view = byId.get(reminderId);
      const overlay = view ? activeOverlay(state.overlays[reminderId], view) : undefined;
      const stillThisOccurrence =
        view !== undefined &&
        isLive(view, overlay, bugs) &&
        fireKey(reminderId, effectiveOf(view, overlay)) === shown.key;
      if (!stillThisOccurrence) {
        stale.push(shown.id);
        delete state.shown[reminderId];
      }
    }
    for (const [id, key] of Object.entries(state.ids)) {
      if (state.fired[key] === undefined && state.schedule[key] === undefined) delete state.ids[id];
    }
    await this.persist(state);
    if (stale.length > 0) await port.clearShown(stale);

    result.armed = Object.keys(state.schedule).length;
    logger.info("reminders.reconciled", {
      armed: result.armed,
      scheduled: result.scheduled,
      cancelled: result.cancelled,
      shown: result.shown,
    });
    return result;
  }

  private async armAlarms(
    state: SchedulerState,
    future: DesiredItem[],
    at: (item: DesiredItem) => number,
    platformMax: number,
    result: ReconcileResult,
    bugs: PlantedBugs,
  ): Promise<void> {
    const { port } = this.deps;
    const settings = state.settings;
    const capacity = Math.max(0, Math.min(settings.maxScheduled, platformMax));
    const armSet = future.slice(0, capacity);
    result.deferredByCap = Math.max(0, future.length - capacity);
    const wanted = new Map<number, { item: DesiredItem; at: number }>();
    for (const item of armSet) wanted.set(idFor(state, item.key), { item, at: at(item) });

    const pending = await port.listPending();
    const pendingById = new Map(pending.map((p) => [p.id, p.at]));
    // Cancel what is armed but no longer wanted (cancelled, completed, dismissed, re-dated, over cap).
    for (const p of pending) {
      if (wanted.has(p.id)) continue;
      if (bugs.keepAlarmOfCancelled) continue;
      await port.cancel(p.id);
      result.cancelled += 1;
    }
    const nextSchedule: SchedulerState["schedule"] = {};
    for (const [id, { item, at: when }] of wanted) {
      const have = pendingById.get(id);
      const known = state.schedule[item.key];
      const unchanged =
        have === when && known !== undefined && known.mode === settings.contentMode && known.at === when;
      if (!unchanged) {
        const content = contentFor(item.view, settings.contentMode, item.key);
        await port.schedule({ ...content, id, at: when });
        result.scheduled += 1;
      }
      nextSchedule[item.key] = {
        id,
        at: when,
        reminderId: item.view.reminder.id,
        mode: settings.contentMode,
      };
    }
    state.schedule = nextSchedule;
  }

  private async fireDue(
    state: SchedulerState,
    due: DesiredItem[],
    now: number,
    result: ReconcileResult,
  ): Promise<number[]> {
    const replaced: number[] = [];
    if (due.length === 0) return replaced;
    const { port } = this.deps;
    const bugs = this.deps.plantedBugs ?? {};
    const s = state.settings;
    const late = due.some((d) => d.effective < now - s.burstWindowMs);
    const room = Math.max(0, s.burstLimit - state.recentShows.length);
    let individual: DesiredItem[];
    let grouped: DesiredItem[];
    if (due.length > s.groupThreshold && late) {
      individual = [];
      grouped = due;
    } else {
      individual = due.slice(0, room);
      grouped = due.slice(room);
      if (grouped.length === 1) individual.push(...grouped.splice(0, 1));
    }

    for (const item of individual) {
      const id = idFor(state, item.key);
      const content = contentFor(item.view, s.contentMode, item.key);
      await this.showOnce(state, [item.key], now, () => port.show({ ...content, id }), bugs);
      const previous = state.shown[item.view.reminder.id];
      if (previous && previous.id !== id) replaced.push(previous.id);
      state.shown[item.view.reminder.id] = { key: item.key, id };
      this.markOverlayFired(state, item.view.reminder.id, item.key);
      state.recentShows.push(now);
      delete state.schedule[item.key];
      result.shown += 1;
    }
    if (grouped.length > 0) {
      const keys = grouped.map((g) => g.key);
      const summary = summaryContent(grouped.length);
      const id = hashKey(`summary:${keys[0]}`);
      await this.showOnce(state, keys, now, () => port.show({ ...summary, id }), bugs);
      for (const g of grouped) delete state.schedule[g.key];
      state.recentShows.push(now);
      result.shown += grouped.length;
    }
    return replaced;
  }

  private markOverlayFired(state: SchedulerState, reminderId: string, key: FireKey): void {
    const overlay = state.overlays[reminderId];
    if (overlay?.kind === "snooze" && overlay.until !== null && fireKey(reminderId, overlay.until) === key) {
      overlay.fired = true;
    }
  }

  /**
   * Fired-before-show: persist the keys, then show. A rejected show un-fires the keys so the next
   * run retries; a crash between the two lines loses the notification (never duplicates it).
   */
  private async showOnce(
    state: SchedulerState,
    keys: FireKey[],
    now: number,
    show: () => Promise<void>,
    bugs: PlantedBugs,
  ): Promise<void> {
    if (bugs.writeFiredAfterShow) {
      await show();
      for (const k of keys) state.fired[k] = now;
      await this.persist(state);
      return;
    }
    for (const k of keys) state.fired[k] = now;
    await this.persist(state);
    try {
      await show();
    } catch (error) {
      for (const k of keys) delete state.fired[k];
      await this.persist(state);
      throw error;
    }
  }
}
