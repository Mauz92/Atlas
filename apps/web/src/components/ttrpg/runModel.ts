import type { Run, RunActionBody, RunCombatant } from "../../api/client";

/** The combatants in turn order (setup: by roster position), removed ones last. */
export function inOrder(run: Run): RunCombatant[] {
  return [...run.combatants].sort((a, b) => {
    if (a.removed !== b.removed) return a.removed ? 1 : -1;
    const ai = a.order_index ?? Number.MAX_SAFE_INTEGER;
    const bi = b.order_index ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

/** Attach the party revision a change to a party member must carry (the server checks it). */
export function withPartyRevisions(run: Run, body: RunActionBody): RunActionBody {
  const row = run.combatants.find((c) => c.id === body.combatant_id);
  if (row && row.party_member_id && row.party_revision != null) {
    return { ...body, party_revisions: { [row.party_member_id]: row.party_revision } };
  }
  return body;
}

/** A one-line description of where the fight stands. */
export function standing(run: Run): string {
  if (run.status === "setup") return "Setting up";
  if (run.status === "ended") return run.outcome ? `Ended: ${run.outcome}` : "Ended";
  const active = run.combatants.find((c) => c.active);
  const prefix = run.status === "paused" ? "Paused. " : "";
  return `${prefix}Round ${run.round}${active ? `: ${active.name}'s turn` : ""}`;
}

export type TieMove = "up" | "down";

/** Reorder one combatant inside a tie group; the rest of the order is untouched. */
export function moveWithin(order: string[], id: string, move: TieMove): string[] {
  const index = order.indexOf(id);
  const target = move === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** How often an idle, visible fight screen checks for changes made on another tab or device. */
export const POLL_MS = 5000;
