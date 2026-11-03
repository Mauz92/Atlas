import { useMemo, useRef, useState } from "react";

import type { Project } from "../api/client";
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
  type TaskViewMode,
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
}

const PRIORITY_CHOICES: [string, string][] = [
  ["", "Any priority"],
  ...[...PRIORITIES]
    .reverse()
    .map((value): [string, string] => [value, value === "none" ? "No priority" : sentenceCase(value)]),
];

/**
 * The Tasks page's single filter bar (UX-07, docs/UX_AUDIT.md §4.3): a search field, five chips
 * (Status, Priority, Project, Due, Sort) that open the shared menu or a small popover, the List /
 * Board toggle and a "…" menu for saved views. It only reports choices; the URL stays the state
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
}: FilterBarProps) {
  const [due, setDue] = useState<HTMLElement | null>(null);
  const [saving, setSaving] = useState<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const more = useRef<HTMLButtonElement>(null);
  const values = chipValues(filter, (id) => projects.find((p) => p.id === id)?.name);
  const setView = (view: TaskViewMode) => onChange({ view });

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

  return (
    <div className="filter-bar" role="search" aria-label="Task filters">
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
        <div className="segmented" role="group" aria-label="View">
          {(["list", "board"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter.view === option}
              onClick={() => setView(option)}
            >
              {option === "list" ? "List" : "Board"}
            </button>
          ))}
        </div>
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
      </div>

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
