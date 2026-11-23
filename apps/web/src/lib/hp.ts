/** The tone of a health bar: green above half, amber above a quarter, red below, grey at 0. */
export function hpTone(hp: number, max: number): "ok" | "warn" | "crit" | "zero" {
  if (hp <= 0) return "zero";
  const share = hp / max;
  return share > 0.5 ? "ok" : share > 0.25 ? "warn" : "crit";
}

/** "Bloodied" at half HP or less (the 5e convention); `downLabel` at 0. Only a label: nothing is decided for the DM. */
export function hpTag(hp: number, max: number, downLabel: string): string {
  if (hp <= 0) return downLabel;
  return hp / max <= 0.5 ? "Bloodied" : "";
}
