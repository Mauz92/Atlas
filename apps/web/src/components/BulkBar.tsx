import type { Project } from "../api/client";
import type { MenuEntry } from "./Menu";
import { MenuButton } from "./MenuButton";

interface BulkBarProps {
  count: number;
  busy: boolean;
  canComplete: boolean;
  projects: Project[];
  onComplete: () => void;
  /** `null` = no project. */
  onMove: (projectId: string | null) => void;
  onDelete: () => void;
  onClear: () => void;
}

/**
 * The floating bulk bar of the Tasks page (UX-07): it sticks above the status bar while rows are
 * selected, so the actions stay in reach however far the list is scrolled. The actions themselves
 * (one revision-checked request per task, failures reported per task) live in the page.
 */
export function BulkBar({
  count,
  busy,
  canComplete,
  projects,
  onComplete,
  onMove,
  onDelete,
  onClear,
}: BulkBarProps) {
  const entries: MenuEntry[] = [
    { kind: "item", id: "none", label: "No project", onSelect: () => onMove(null) },
    ...projects.map(
      (project): MenuEntry => ({
        kind: "item",
        id: project.id,
        label: project.name,
        onSelect: () => onMove(project.id),
      }),
    ),
  ];
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-count">{count} selected</span>
      <button type="button" disabled={busy || !canComplete} onClick={onComplete}>
        Complete selected
      </button>
      <MenuButton
        menuLabel="Move to project"
        disabled={busy}
        entries={entries}
      >
        Move to project…
      </MenuButton>
      <button type="button" className="danger" disabled={busy} onClick={onDelete}>
        Delete selected
      </button>
      <button type="button" className="ghost" onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}
