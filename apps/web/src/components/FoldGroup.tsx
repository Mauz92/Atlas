import { useId, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "./Icon";

interface FoldGroupProps {
  /** "Completed", "Archived": the count is appended as "(n)". */
  title: string;
  count: number;
  children: ReactNode;
}

/**
 * A folded group of finished work (UX-07): a heading-sized disclosure button "Completed (3)" that
 * shows its list when opened. Renders nothing for an empty group.
 */
export function FoldGroup({ title, count, children }: FoldGroupProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (count === 0) return null;
  return (
    <section className="fold-group">
      <h2>
        <button
          type="button"
          className="fold-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
          {title} ({count})
        </button>
      </h2>
      {open ? <div id={id}>{children}</div> : null}
    </section>
  );
}
