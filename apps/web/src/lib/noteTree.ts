import type { NoteSummary } from "../api/client";

export interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  notes: NoteSummary[];
}

/** Build a nested tree from the flat folder list and note list the API returns. */
export function buildTree(folders: string[], notes: NoteSummary[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], notes: [] };
  const index = new Map<string, FolderNode>([["", root]]);

  for (const path of folders) {
    const segments = path.split("/");
    let parent = root;
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      let node = index.get(current);
      if (!node) {
        node = { name: segment, path: current, folders: [], notes: [] };
        index.set(current, node);
        parent.folders.push(node);
      }
      parent = node;
    }
  }

  for (const note of notes) {
    const parentPath = note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "";
    const parent = index.get(parentPath) ?? root;
    parent.notes.push(note);
  }

  const sort = (node: FolderNode) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.notes.sort((a, b) => a.path.localeCompare(b.path));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}
