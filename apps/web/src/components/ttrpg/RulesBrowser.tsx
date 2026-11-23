import { useEffect, useRef, useState } from "react";

import { RULE_GROUPS, SRD_ATTRIBUTION, searchRules, type Rule, type RuleBlock } from "../../lib/srdRules";

function Block({ block }: { block: RuleBlock }) {
  if (typeof block === "string") return <p>{block}</p>;
  if ("list" in block) {
    return (
      <ul>
        {block.list.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  return (
    <table>
      <tbody>
        {block.table.map((row, index) => (
          <tr key={row.join("|")}>
            {row.map((cell) =>
              index === 0 ? <th key={cell}>{cell}</th> : <td key={cell}>{cell}</td>,
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The rules reference (SRD 5.1): a searchable list of collapsible entries. `focusId` opens one entry,
 * scrolls to it and flashes it (a condition chip in a fight, or a link such as `/ttrpg/rules?rule=prone`).
 * The text is plain React text from bundled data, never HTML.
 */
export function RulesBrowser({
  focusId,
  compact = false,
  groupLevel = 2,
}: {
  focusId?: string | null;
  /** Inside the fight screen: no outer scroll height limit beyond the pane's own. */
  compact?: boolean;
  /** Heading level of the group titles: 2 on its own page, 3 under a pane heading. */
  groupLevel?: 2 | 3;
}) {
  const Group = `h${groupLevel}` as const;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDetailsElement>());

  useEffect(() => {
    if (!focusId) return undefined;
    setQuery("");
    setOpen((current) => new Set(current).add(focusId));
    setFlash(focusId);
    const timer = window.setTimeout(() => setFlash(null), 1300);
    // wait one frame so the entry exists and is expanded before scrolling to it
    const frame = window.requestAnimationFrame(() => {
      refs.current.get(focusId)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    });
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [focusId]);

  const found = searchRules(query);
  const searching = query.trim() !== "";

  function toggle(rule: Rule, next: boolean) {
    setOpen((current) => {
      const copy = new Set(current);
      if (next) copy.add(rule.id);
      else copy.delete(rule.id);
      return copy;
    });
  }

  return (
    <div className={`ttrpg-rules${compact ? " compact" : ""}`}>
      <input
        type="search"
        className="ttrpg-rules-search"
        placeholder="Search the rules (try prone, cover, death)"
        aria-label="Search the rules"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="ttrpg-rules-list" tabIndex={0} role="region" aria-label="Rules">
        {found.length === 0 && <p className="muted">Nothing in these rules matches “{query}”.</p>}
        {RULE_GROUPS.map((group) => {
          const rules = found.filter((rule) => rule.group === group);
          if (rules.length === 0) return null;
          return (
            <section key={group} aria-label={group} className="ttrpg-rules-group">
              <Group>{group}</Group>
              {rules.map((rule) => (
                <details
                  key={rule.id}
                  id={`rule-${rule.id}`}
                  className={`ttrpg-rule${flash === rule.id ? " flash" : ""}`}
                  open={searching || open.has(rule.id)}
                  ref={(node) => {
                    if (node) refs.current.set(rule.id, node);
                    else refs.current.delete(rule.id);
                  }}
                  onToggle={(event) => {
                    if (!searching) toggle(rule, (event.currentTarget as HTMLDetailsElement).open);
                  }}
                >
                  <summary>{rule.title}</summary>
                  <div className="ttrpg-rule-body">
                    {rule.body.map((block, index) => (
                      <Block key={index} block={block} />
                    ))}
                  </div>
                </details>
              ))}
            </section>
          );
        })}
      </div>
      <p className="muted ttrpg-attribution">{SRD_ATTRIBUTION}</p>
    </div>
  );
}
