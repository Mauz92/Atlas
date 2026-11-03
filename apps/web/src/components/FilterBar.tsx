import { useMemo, useRef, useState } from "react";

import type { Project } from "../api/client";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { SHEET_QUERY } from "../lib/phone";
import {
  DUE_PRESETS,
  SORT_LABELS,
  STATUS_CHOICES,
  chipValues,
  dueRangeFor,
  duePresetOf,
  isFiltered,
  type SavedFilter,
  type TaskFilter,
} from "../lib/taskFilters";
import { PRIORITIES } from "../lib/taskForm";
import { sentenceCase } from "../lib/tasks";
import { Icon } from "./Icon";
import type { MenuEntry } from "./Menu";
import { MenuButton, choiceEntries } from "./MenuButton";
import { Popover } from "./Popover";

interface FilterBarProps {
  filter: TaskFilter;
  /** The search box's text (applied to the URL after a short pause by the page). */
  text: string;
  onText: (text: string) => void;
  projects: Project[];
  onChange: (patch: Partial<TaskFilter>) => void;
  onReset: () => void;
  saved: SavedFilter[];
  onSaveView: (name: string) => boolean;
  onApplyView: (entry: SavedFilter) => void;
  onRemoveView: (id: string) => void;
  /** Touch and phone only (UX-11): enter "Select" mode (the select boxes are hidden until then). */
  onSelectMode?: () => void;
}

const PRIORITY_CHOICES: [string, string][] = [
  ["", "Any priority"],
  ...[...PRIORITIES]
    .reverse()
    .map((value): [string, string] => [value, value === "none" ? "No priority" : sentenceCase(value)]),
];

/**
 * The Tasks page's single filter bar (UX-07, docs/UX_AUDIT.md §4.3): a search field, five chips
 * (Status, Priority, Project, Due, Sort) that open the shared menu or a small popover, and a
 * "…" menu for saved views and (touch) Select mode. It only reports choices; the URL stays the state
 * (ADR-0045) and the page owns it.
 */
export function FilterBar({
  filter,
  text,
  onText,
  projects,
  onChange,
  onReset,
  saved,
  onSaveView,
  onApplyView,
  onRemoveView,
  onSelectMode,
}: FilterBarProps) {
  // Phone and touch (UX-11): five chips cannot share one line at 360 px without wrapping or
  // scrolling, so they become one "Filters" button that opens the same choices as a sheet.
  const compact = useMediaQuery(SHEET_QUERY, false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [due, setDue] = useState<HTMLElement | null>(null);
  const [saving, setSaving] = useState<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const more = useRef<HTMLButtonElement>(null);
  const values = chipValues(filter, (id) => projects.find((p) => p.id === id)?.name);

  const projectChoices = useMemo<[string, string][]>(
    () => [["", "Any project"], ...projects.map((p): [string, string] => [p.id, p.name])],
    [projects],
  );

  const chip = (
    label: string,
    value: string,
    set: boolean,
    entries: MenuEntry[],
  ) => (
    <MenuButton
      key={label}
      menuLabel={label}
      entries={entries}
      className={`chip${set ? " is-set" : ""}`}
    >
      {value ? `${label}: ${value}` : label}
      <Icon name="chevron-down" size={12} />
    </MenuButton>
  );

  const viewEntries: MenuEntry[] = [
    ...(onSelectMode
      ? [
          {
            kind: "item",
            id: "select-tasks",
            label: "Select tasks",
            icon: "square-check",
            onSelect: onSelectMode,
          } satisfies MenuEntry,
        ]
      : []),
    {
      kind: "item",
      id: "save-view",
      label: "Save this view…",
      onSelect: () => {
        setName("");
        setSaving(more.current);
      },
    },
  ];
  if (saved.length > 0) {
    viewEntries.push(
      { kind: "separator", id: "sep-saved" },
      {
        kind: "submenu",
        id: "saved-views",
        label: "Saved views",
        hint: String(saved.length),
        entries: saved.map((entry) => ({
          kind: "item",
          id: `view-${entry.id}`,
          label: entry.name,
          onSelect: () => onApplyView(entry),
        })),
      },
      {
        kind: "submenu",
        id: "remove-views",
        label: "Remove a saved view",
        entries: saved.map((entry) => ({
          kind: "item",
          id: `remove-${entry.id}`,
          label: entry.name,
          danger: true,
          onSelect: () => onRemoveView(entry.id),
        })),
      },
    );
  }

  const preset = duePresetOf(filter);

  const activeCount = [
    filter.status !== "open",
    Boolean(filter.priority),
    Boolean(filter.project),
    preset !== "any",
    filter.sort !== "urgency",
  ].filter(Boolean).length;
  const filterEntries: MenuEntry[] = [
    {
      kind: "submenu",
      id: "f-status",
      label: "Status",
      hint: values.status,
      entries: choiceEntries(STATUS_CHOICES, filter.status, (status) => onChange({ status })),
    },
    {
      kind: "submenu",
      id: "f-priority",
      label: "Priority",
      hint: values.priority || "Any",
      entries: choiceEntries(PRIORITY_CHOICES, filter.priority, (priority) => onChange({ priority })),
    },
    {
      kind: "submenu",
      id: "f-project",
      label: "Project",
      hint: values.project || "Any",
      entries: choiceEntries(projectChoices, filter.project, (project) => onChange({ project })),
    },
    {
      kind: "item",
      id: "f-due",
      label: "Due date…",
      hint: values.due || "Any",
      onSelect: () => setDue(filtersButton.current),
    },
    {
      kind: "submenu",
      id: "f-sort",
      label: "Sort",
      hint: values.sort,
      entries: choiceEntries(Object.entries(SORT_LABELS), filter.sort, (sort) =>
        onChange({ sort: sort as TaskFilter["sort"] }),
      ),
    },
    ...(isFiltered(filter)
      ? [
          { kind: "separator", id: "f-sep" } satisfies MenuEntry,
          { kind: "item", id: "f-reset", label: "Reset filters", onSelect: onReset } satisfies MenuEntry,
        ]
      : []),
  ];

  const viewControls = (
    <>
      <MenuButton
        menuLabel="Filter options"
        ariaLabel="Filter options"
        title="Saved views"
        className="icon-button ghost"
        buttonRef={more}
        entries={viewEntries}
      >
        <Icon name="ellipsis" />
      </MenuButton>
    </>
  );

  return (
    <div className={`filter-bar${compact ? " is-compact" : ""}`} role="search" aria-label="Task filters">
      <div className="filter-search">
        <Icon name="search" size={14} />
        <input
          aria-label="Search"
          type="search"
          value={text}
          onChange={(event) => onText(event.target.value)}
          placeholder="Search tasks"
        />
      </div>

      {compact ? (
        <div className="filter-end">
          <MenuButton
            menuLabel="Filters"
            ariaLabel={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
            className={`chip filters-button${activeCount > 0 ? " is-set" : ""}`}
            buttonRef={filtersButton}
            entries={filterEntries}
          >
            Filters
            {activeCount > 0 ? (
              <span className="chip-count" aria-hidden="true">
                {activeCount}
              </span>
            ) : null}
            <Icon name="chevron-down" size={12} />
          </MenuButton>
          {viewControls}
        </div>
      ) : (
        <>
      <div className="filter-chips">
        {chip(
          "Status",
          values.status,
          filter.status !== "open",
          choiceEntries(STATUS_CHOICES, filter.status, (status) => onChange({ status })),
        )}
        {chip(
          "Priority",
          values.priority,
          Boolean(filter.priority),
          choiceEntries(PRIORITY_CHOICES, filter.priority, (priority) => onChange({ priority })),
        )}
        {chip(
          "Project",
          values.project,
          Boolean(filter.project),
          choiceEntries(projectChoices, filter.project, (project) => onChange({ project })),
        )}
        <button
          type="button"
          className={`chip${preset === "any" ? "" : " is-set"}`}
          aria-haspopup="dialog"
          aria-expanded={due !== null}
          onClick={(event) => {
            const button = event.currentTarget;
            setDue((open) => (open ? null : button));
          }}
        >
          {values.due ? `Due: ${values.due}` : "Due"}
          <Icon name="chevron-down" size={12} />
        </button>
        {chip(
          "Sort",
          values.sort,
          filter.sort !== "urgency",
          choiceEntries(Object.entries(SORT_LABELS), filter.sort, (sort) =>
            onChange({ sort: sort as TaskFilter["sort"] }),
          ),
        )}
      </div>

          <div className="filter-end">
            {isFiltered(filter) ? (
              <button type="button" className="ghost" onClick={onReset}>
                Reset filters
              </button>
            ) : null}
            {viewControls}
          </div>
        </>
      )}

      {due ? (
        <Popover label="Due date" anchor={due} onClose={() => setDue(null)}>
          <div className="popover-body">
            <div className="popover-presets" role="group" aria-label="Due presets">
              {DUE_PRESETS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="ghost"
                  aria-pressed={preset === key}
                  onClick={() => onChange(dueRangeFor(key))}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              Due from
              <input
                aria-label="Due from"
                type="date"
                value={filter.dueFrom}
                onChange={(event) => onChange({ dueFrom: event.target.value })}
              />
            </label>
            <label>
              Due to
              <input
                aria-label="Due to"
                type="date"
                value={filter.dueTo}
                onChange={(event) => onChange({ dueTo: event.target.value })}
              />
            </label>
          </div>
        </Popover>
      ) : null}

      {saving ? (
        <Popover label="Save this view" anchor={saving} onClose={() => setSaving(null)}>
          <form
            className="popover-body"
            onSubmit={(event) => {
              event.preventDefault();
              if (onSaveView(name)) {
                setSaving(null);
                setName("");
              }
            }}
          >
            <input
              aria-label="Saved filter name"
              value={name}
              maxLength={60}
              placeholder="Name this view"
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" className="primary" disabled={!name.trim()}>
              Save this view
            </button>
          </form>
        </Popover>
      ) : null}
    </div>
  );
}
