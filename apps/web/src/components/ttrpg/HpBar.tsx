import { useEffect, useState } from "react";

import { hpTag, hpTone } from "../../lib/hp";

/**
 * A health bar: the fill, a pale trail that slides to the new value (so a change is easy to see),
 * tick marks at a quarter, half and three quarters, and striped temporary hit points after the fill.
 */
export function HpBar({
  name,
  hp,
  max,
  temp = 0,
  downLabel = "Down",
}: {
  name: string;
  hp: number;
  max: number;
  temp?: number;
  downLabel?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round((hp / max) * 100)));
  const tempPct = Math.min(100 - pct, Math.round((temp / max) * 100));
  const [from, setFrom] = useState(pct);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setFrom(pct));
    return () => window.cancelAnimationFrame(frame);
  }, [pct]);
  const tone = hpTone(hp, max);
  const tag = hpTag(hp, max, downLabel);
  const label = `${name}: ${hp} of ${max} hit points${temp ? `, plus ${temp} temporary` : ""}${tag ? `, ${tag.toLowerCase()}` : ""}`;
  return (
    <div
      className={`tt-hp ${tone}`}
      role="img"
      aria-label={label}
      style={{ ["--p" as string]: pct, ["--t" as string]: tempPct, ["--from" as string]: from }}
    >
      <i className="trail" />
      <i className="fill" />
      <i className="temp" />
      <i className="ticks" />
      <span className="txt" aria-hidden="true">
        <span>
          {hp} / {max}
          {temp ? ` +${temp}` : ""}
        </span>
        <em>{tag}</em>
      </span>
    </div>
  );
}
