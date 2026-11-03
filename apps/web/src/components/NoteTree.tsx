import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import type { FolderNode } from "../lib/noteTree";
import { Icon } from "./Icon";
import { Menu, type MenuEntry } from "./Menu";

/** What a row menu or an inline name box acts on. */
export type TreeTarget =
  | { kind: "note"; id: string; path: string; title: string }
  | { kind: "folder"; path: string; name: string };

export interface TemplateChoice {
  id: string;
  name: string;
}

export interface NoteTreeActions {
  /** Start renaming in place. */
  rename: (target: TreeTarget) => void;
  move: (id: string, folder: string) => void;
  remove: (target: TreeTarget) => void;
  newIn: (kind: "note" | "folder", folder: string) => void;
  newFromTemplate: (templateId: string, folder: string) => void;
}

/** An inline name box for a new note or folder, shown at the top of `folder`. */
export interface TreeCreation {
  folder: string;
  label: string;
}

interface NoteTreeProps {
  tree: FolderNode;
  selectedId: string | null;
  /** Folder paths collapsed by the person; every other folder is open. */
  collapsed: ReadonlySet<string>;
  onToggleFolder: (path: string) => void;
  onSelect: (id: string) => void;
  /** All folder paths (the "Move to" list). */
  folderPaths: readonly string[];
  templates: readonly TemplateChoice[];
  actions: NoteTreeActions;
  creation: TreeCreation | null;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
  renaming: TreeTarget | null;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}

type OpenMenu = { anchor: HTMLElement; label: string; entries: MenuEntry[] };

/** The file name without folder and `.md`, which is what a person edits when renaming. */
function baseName(target: TreeTarget): string {
  return target.kind === "folder" ? target.name : target.path.split("/").pop()!.replace(/\.md$/i, "");
}

function NameInput({
  label,
  initial = "",
  onCommit,
  onCancel,
}: {
  label: string;
  initial?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);

  function finish(commit: boolean) {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  }

  return (
    <input
      type="text"
      className="tree-name-input"
      aria-label={label}
      value={value}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(false)}
    />
  );
}

export function NoteTree(props: NoteTreeProps) {
  const menuId = useId();
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  function entriesFor(target: TreeTarget): MenuEntry[] {
    const { actions, templates, folderPaths } = props;
    const home = target.kind === "folder" ? target.path : target.path.split("/").slice(0, -1).join("/");
    const fromTemplate: MenuEntry =
      templates.length === 0
        ? {
            kind: "item",
            id: "template",
            label: "New from template",
            icon: "layout-template",
            hint: "No templates",
            disabled: true,
            onSelect: () => undefined,
          }
        : {
            kind: "submenu",
            id: "template",
            label: "New from template",
            icon: "layout-template",
            entries: templates.map((template) => ({
              kind: "item" as const,
              id: `template-${template.id}`,
              label: template.name,
              onSelect: () => actions.newFromTemplate(template.id, home),
            })),
          };
    if (target.kind === "folder") {
      return [
        { kind: "item", id: "new-note", label: "New note here", icon: "file-plus", onSelect: () => actions.newIn("note", target.path) },
        { kind: "item", id: "new-folder", label: "New folder here", icon: "folder-plus", onSelect: () => actions.newIn("folder", target.path) },
        fromTemplate,
        { kind: "separator", id: "s1" },
        { kind: "item", id: "rename", label: "Rename", onSelect: () => actions.rename(target) },
        { kind: "item", id: "delete", label: "Delete folder", icon: "trash-2", danger: true, onSelect: () => actions.remove(target) },
      ];
    }
    const here = home;
    const destinations = ["", ...folderPaths];
    return [
      { kind: "item", id: "rename", label: "Rename", onSelect: () => actions.rename(target) },
      {
        kind: "submenu",
        id: "move",
        label: "Move to…",
        icon: "folder-input",
        entries: destinations.map((folder) => ({
          kind: "item" as const,
          id: `move-${folder || "root"}`,
          label: folder || "Top level",
          checked: folder === here,
          onSelect: () => (folder === here ? undefined : actions.move(target.id, folder)),
        })),
      },
      fromTemplate,
      { kind: "separator", id: "s1" },
      { kind: "item", id: "delete", label: "Delete", icon: "trash-2", danger: true, onSelect: () => actions.remove(target) },
    ];
  }

  function toggleMenu(anchor: HTMLElement, label: string, target: TreeTarget) {
    setMenu((current) => (current?.anchor === anchor ? null : { anchor, label, entries: entriesFor(target) }));
  }

  return (
    <>
      <Branch {...props} node={props.tree} depth={0} menu={menu} menuId={menuId} toggleMenu={toggleMenu} />
      {menu ? (
        <Menu
          id={menuId}
          label={menu.label}
          anchor={menu.anchor}
          entries={menu.entries}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}

interface BranchProps extends NoteTreeProps {
  node: FolderNode;
  depth: number;
  menu: OpenMenu | null;
  menuId: string;
  toggleMenu: (anchor: HTMLElement, label: string, target: TreeTarget) => void;
}

function Branch(props: BranchProps) {
  const { node, depth, selectedId, collapsed, creation, renaming, menu, menuId, toggleMenu } = props;
  const creatingHere = creation !== null && creation.folder === node.path;

  return (
    <ul className="tree" data-depth={depth}>
      {creatingHere ? (
        <li className="tree-create">
          <NameInput label={creation.label} onCommit={props.onCreate} onCancel={props.onCancelCreate} />
        </li>
      ) : null}
      {node.folders.map((folder) => {
        const target: TreeTarget = { kind: "folder", path: folder.path, name: folder.name };
        const creatingInside =
          creation !== null &&
          (creation.folder === folder.path || creation.folder.startsWith(`${folder.path}/`));
        const open = !collapsed.has(folder.path) || creatingInside;
        const isRenaming = renaming?.kind === "folder" && renaming.path === folder.path;
        return (
          <li key={folder.path}>
            <div className="tree-row">
              {isRenaming ? (
                <NameInput
                  label={`Rename folder ${folder.name}`}
                  initial={baseName(target)}
                  onCommit={props.onRename}
                  onCancel={props.onCancelRename}
                />
              ) : (
                <button
                  type="button"
                  className="tree-folder"
                  aria-expanded={open}
                  onClick={() => props.onToggleFolder(folder.path)}
                >
                  <Icon name={open ? "chevron-down" : "chevron-right"} />
                  <Icon name="folder" />
                  <span className="tree-label">{folder.name}</span>
                </button>
              )}
              <RowMenuButton
                label={`Actions for folder ${folder.name}`}
                menu={menu}
                menuId={menuId}
                onToggle={(anchor) => toggleMenu(anchor, `Actions for folder ${folder.name}`, target)}
              />
            </div>
            {open ? <Branch {...props} node={folder} depth={depth + 1} /> : null}
          </li>
        );
      })}
      {node.notes.map((note) => {
        const target: TreeTarget = { kind: "note", id: note.id, path: note.path, title: note.title };
        const isRenaming = renaming?.kind === "note" && renaming.id === note.id;
        return (
          <li key={note.id}>
            <div className="tree-row">
              {isRenaming ? (
                <NameInput
                  label={`Rename ${note.title}`}
                  initial={baseName(target)}
                  onCommit={props.onRename}
                  onCancel={props.onCancelRename}
                />
              ) : (
                <button
                  type="button"
                  className={`tree-note${note.id === selectedId ? " selected" : ""}`}
                  aria-current={note.id === selectedId ? "true" : undefined}
                  title={note.path}
                  onClick={() => props.onSelect(note.id)}
                >
                  <Icon name="file-text" />
                  <span className="tree-label">{note.title}</span>
                </button>
              )}
              <RowMenuButton
                label={`Actions for ${note.title}`}
                menu={menu}
                menuId={menuId}
                onToggle={(anchor) => toggleMenu(anchor, `Actions for ${note.title}`, target)}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RowMenuButton({
  label,
  menu,
  menuId,
  onToggle,
}: {
  label: string;
  menu: OpenMenu | null;
  menuId: string;
  onToggle: (anchor: HTMLElement) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const open = menu !== null && menu.anchor === button.current;
  return (
    <button
      ref={button}
      type="button"
      className="ghost icon-button tree-more"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={(event) => onToggle(event.currentTarget)}
    >
      <Icon name="ellipsis" />
    </button>
  );
}
