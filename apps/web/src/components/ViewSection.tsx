import type { ReactNode } from "react";

import { Icon } from "./Icon";

interface ViewSectionProps {
  title: string;
  /** Items in the section; shown after the title. Hidden from assistive technology (a list announces its own length). */
  count?: number;
  /** `overdue` and `today` give the header an icon and a colour (never colour alone: the title says it). */
  tone?: "overdue" | "today";
  /** Landmark name for sections that are regions of their own (Scheduled work, Daily note, Events). */
  label?: string;
  /** The weekend, a past or an empty day: a quieter header. */
  muted?: boolean;
  /** Extra classes for the section (Week adds `week-day`, `is-today`, `is-empty`). */
  className?: string;
  children: ReactNode;
}

/**
 * One section of a view (UX-09, ADR-0062): on a phone a card on the tinted page, with a sticky
 * header band (title, count, and for Overdue / Due today an icon and a colour). The `h2` is the
 * header itself and the section's first child, so existing queries (`heading` then its parent)
 * keep working; the count is `aria-hidden` so the heading's accessible name stays the title.
 */
export function ViewSection({ title, count, tone, label, muted, className, children }: ViewSectionProps) {
  return (
    <section
      className={`view-section${tone ? ` tone-${tone}` : ""}${muted ? " is-muted" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
    >
      <h2 className="section-head">
        {tone === "overdue" ? <Icon name="triangle-alert" size={14} /> : null}
        {tone === "today" ? <Icon name="sun" size={14} /> : null}
        <span className="section-title">{title}</span>
        {count !== undefined ? (
          <span className="section-count" aria-hidden="true">
            {count}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}
