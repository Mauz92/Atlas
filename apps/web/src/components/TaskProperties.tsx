import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject, TextareaHTMLAttributes } from "react";

import { parseTags } from "../lib/taskForm";
import { Icon, type IconName } from "./Icon";
import { Menu, type MenuEntry } from "./Menu";

/**
 * Building blocks of the task detail's property list (UX-04, UX_AUDIT §3.4/§4.3): a row is a
 * muted label with an icon and a value that is a menu button or a borderless inline editor. They
 * only render and report; saving is the panel's autosave session (ADR-0053).
 */

interface PropertyRowProps {
  icon: IconName;
  label: string;
  /** The id the value control points at with `aria-labelledby`. */
  labelId: string;
  children: ReactNode;
  /** A save of this property was rejected: the server's words, shown under the value. */
  error?: string | null;
}

export function PropertyRow({ icon, label, labelId, children, error }: PropertyRowProps) {
  return (
    <div className="task-prop">
      <span className="task-prop-label" id={labelId}>
        <Icon name={icon} />
        <span>{label}</span>
      </span>
      <div className="task-prop-value">{children}</div>
      {error ? (
        <p className="task-prop-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface MenuPropertyProps {
  icon: IconName;
  label: string;
  /** What the button shows; `empty` renders it muted. */
  value: ReactNode;
  empty?: boolean;
  entries: MenuEntry[];
  error?: string | null;
  disabled?: boolean;
}

/** A property whose value opens the shared menu (status, priority, project). */
export function MenuProperty({
  icon,
  label,
  value,
  empty = false,
  entries,
  error,
  disabled = false,
}: MenuPropertyProps) {
  const ids = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <PropertyRow icon={icon} label={label} labelId={`${ids}-label`} error={error}>
      <button
        type="button"
        id={`${ids}-value`}
        className={`task-prop-button${empty ? " is-empty" : ""}`}
        aria-labelledby={`${ids}-label ${ids}-value`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? `${ids}-menu` : undefined}
        disabled={disabled}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        {value}
      </button>
      {anchor ? (
        <Menu
          id={`${ids}-menu`}
          label={label}
          anchor={anchor}
          entries={entries}
          onClose={() => setAnchor(null)}
        />
      ) : null}
    </PropertyRow>
  );
}

/** A textarea that grows with its content (title, description); no inner scrollbar. */
export function AutoGrowTextarea({
  textareaRef,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? own;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [props.value, ref]);
  return <textarea ref={ref} rows={1} {...props} />;
}

interface TimeZonePropertyProps {
  /** The task's own zone ("" = it follows the viewer's zone). */
  value: string;
  viewerZone?: string;
  onChoose: (zone: string) => void;
  error?: string | null;
}

function supportedZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

const MAX_SHOWN = 60;

interface ZoneOption {
  id: string;
  label: string;
  value: string;
}

/**
 * The time-zone property: a button showing the zone, opening a searchable list (combobox +
 * listbox) inline under the row instead of a 400-entry native select. A name the browser does not
 * list can still be used as typed; the server validates it and its message is shown on the row.
 */
export function TimeZoneProperty({ value, viewerZone, onChoose, error }: TimeZonePropertyProps) {
  const ids = useId();
  const zones = useMemo(supportedZones, []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const options = useMemo<ZoneOption[]>(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "_");
    const list: ZoneOption[] = [];
    if (value !== "" && viewerZone) {
      list.push({ id: "default", label: `Use my time zone (${viewerZone})`, value: "" });
    }
    const matches = zones.filter((zone) => q === "" || zone.toLowerCase().includes(q));
    // Exact and prefix matches first, so "tokyo" finds Asia/Tokyo at the top.
    matches.sort((a, b) => {
      const rank = (zone: string) => {
        const lower = zone.toLowerCase();
        if (lower === q) return 0;
        if (lower.split("/").some((part) => part.startsWith(q))) return 1;
        return 2;
      };
      return rank(a) - rank(b);
    });
    for (const zone of matches.slice(0, MAX_SHOWN)) {
      list.push({ id: zone, label: zone, value: zone });
    }
    const typed = query.trim();
    if (typed !== "" && !zones.some((zone) => zone.toLowerCase() === typed.toLowerCase())) {
      list.push({ id: "typed", label: `Use “${typed}”`, value: typed });
    }
    return list;
  }, [query, zones, value, viewerZone]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => setActive(0), [query]);

  function close(refocus: boolean) {
    setOpen(false);
    setQuery("");
    if (refocus) button.current?.focus();
  }

  function choose(option: ZoneOption | undefined) {
    if (!option) return;
    close(true);
    if (option.value !== value) onChoose(option.value);
  }

  const optionId = (index: number) => `${ids}-zone-${index}`;
  const shown = value || (viewerZone ? viewerZone : "Empty");

  return (
    <PropertyRow icon="globe" label="Time zone" labelId={`${ids}-label`} error={error}>
      <button
        ref={button}
        type="button"
        id={`${ids}-value`}
        className={`task-prop-button${value ? "" : " is-empty"}`}
        aria-labelledby={`${ids}-label ${ids}-value`}
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {shown}
        {!value && viewerZone ? <span className="task-prop-note">default</span> : null}
      </button>
      {open ? (
        <div
          className="tz-picker"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(false);
          }}
        >
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label="Search time zones"
            aria-expanded="true"
            aria-controls={`${ids}-zones`}
            aria-autocomplete="list"
            aria-activedescendant={options[active] ? optionId(active) : undefined}
            placeholder="Search, e.g. Tokyo"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((at) => Math.min(at + 1, options.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((at) => Math.max(at - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(options[active]);
              } else if (event.key === "Escape") {
                // Closes the list only, not the panel.
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }
            }}
          />
          <ul id={`${ids}-zones`} role="listbox" aria-label="Time zones" className="tz-list">
            {options.map((option, index) => (
              <li
                key={option.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className={index === active ? "is-active" : undefined}
                // Keep focus in the search field while choosing with the pointer.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
              >
                {option.label}
                {option.value === value && value !== "" ? (
                  <Icon name="check" className="tz-check" />
                ) : null}
              </li>
            ))}
            {options.length === 0 ? <li className="tz-empty">No matching time zone</li> : null}
          </ul>
        </div>
      ) : null}
    </PropertyRow>
  );
}

interface TagsPropertyProps {
  /** The comma-separated tags the draft holds. */
  value: string;
  onChange: (tags: string) => void;
  error?: string | null;
}

/**
 * Tags as `#tag` chips with a remove button each, plus a field that adds what is typed on Enter, a
 * comma or leaving it. The server normalises and de-duplicates (ADR-0044); the chips then show its
 * answer.
 */
export function TagsProperty({ value, onChange, error }: TagsPropertyProps) {
  const ids = useId();
  const [text, setText] = useState("");
  const tags = parseTags(value);

  function commit(raw: string) {
    const added = parseTags(raw);
    setText("");
    if (added.length > 0) onChange([...tags, ...added].join(", "));
  }

  return (
    <PropertyRow icon="tag" label="Tags" labelId={`${ids}-label`} error={error}>
      <div className="task-tags">
        {tags.length > 0 ? (
          <ul className="task-chip-list" aria-label="Tags">
            {tags.map((tag, index) => (
              <li key={`${tag}-${index}`} className="task-chip">
                <span>#{tag}</span>
                <button
                  type="button"
                  className="task-chip-remove"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => onChange(tags.filter((_, at) => at !== index).join(", "))}
                >
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          type="text"
          className="task-chip-input"
          aria-label="Add a tag"
          placeholder={tags.length > 0 ? "Add…" : "Empty"}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            const cut = next.lastIndexOf(",");
            if (cut >= 0) {
              commit(next.slice(0, cut));
              setText(next.slice(cut + 1).trimStart());
            } else {
              setText(next);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(text);
            } else if (event.key === "Escape") {
              // Keep what was typed: it is added before the panel's Esc closes it.
              commit(text);
            }
          }}
          onBlur={() => commit(text)}
        />
      </div>
    </PropertyRow>
  );
}
