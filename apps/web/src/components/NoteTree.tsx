import type { FolderNode } from "../lib/noteTree";

interface NoteTreeProps {
  tree: FolderNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSelectFolder: (path: string) => void;
}

interface BranchProps {
  node: FolderNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSelectFolder: (path: string) => void;
}

export function NoteTree({ tree, selectedId, onSelect, onSelectFolder }: NoteTreeProps) {
  return (
    <Branch node={tree} selectedId={selectedId} onSelect={onSelect} onSelectFolder={onSelectFolder} />
  );
}

function Branch({ node, selectedId, onSelect, onSelectFolder }: BranchProps) {
  return (
    <ul className="tree">
      {node.folders.map((folder) => (
        <li key={folder.path}>
          <button type="button" className="tree-folder" onClick={() => onSelectFolder(folder.path)}>
            {folder.name}/
          </button>
          <Branch
            node={folder}
            selectedId={selectedId}
            onSelect={onSelect}
            onSelectFolder={onSelectFolder}
          />
        </li>
      ))}
      {node.notes.map((note) => (
        <li key={note.id}>
          <button
            type="button"
            className={`tree-note${note.id === selectedId ? " selected" : ""}`}
            onClick={() => onSelect(note.id)}
          >
            {note.title}
          </button>
        </li>
      ))}
    </ul>
  );
}
