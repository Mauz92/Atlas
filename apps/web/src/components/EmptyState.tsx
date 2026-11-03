import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

interface EmptyStateProps {
  icon: IconName;
  /** One line saying what is missing and, where useful, why or what to do. */
  children: ReactNode;
  /** At most one action, drawn as an ordinary (secondary) button. */
  action?: { label: string; onClick: () => void };
  /** A tighter variant for a section inside a page. */
  compact?: boolean;
}

/**
 * The one empty state (UX-08, ADR-0058, docs/UX_AUDIT.md §3.4): an icon, a sentence and an optional
 * single action, centred in its section. Not a `role="status"`: pages own that role and the specs
 * read it unscoped.
 */
export function EmptyState({ icon, children, action, compact }: EmptyStateProps) {
  return (
    <div className={`empty-state${compact ? " compact" : ""}`}>
      <Icon name={icon} size={compact ? 20 : 24} />
      <p>{children}</p>
      {action ? (
        <button type="button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
