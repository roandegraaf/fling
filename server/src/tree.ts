import type { FileRow } from './db.ts';
import { ancestorsOf, basenameOf } from './paths.ts';

export interface TreeFile {
  type: 'file';
  name: string;
  path: string;
  size: number;
  id: string;
}

export interface TreeDir {
  type: 'dir';
  name: string;
  path: string;
  size: number;
  fileCount: number;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeDir;

/**
 * Turns the flat `files` + `dirs` rows back into the folder tree the sender
 * dropped, so the recipient page can offer "download this folder as a zip".
 * Empty folders come from the `dirs` table — they have no files to imply them.
 */
export function buildTree(files: FileRow[], emptyDirs: string[] = []): TreeNode[] {
  const root: TreeDir = { type: 'dir', name: '', path: '', size: 0, fileCount: 0, children: [] };
  const dirIndex = new Map<string, TreeDir>([['', root]]);

  function ensureDir(dirPath: string): TreeDir {
    const existing = dirIndex.get(dirPath);
    if (existing) return existing;

    const node: TreeDir = {
      type: 'dir',
      name: basenameOf(dirPath),
      path: dirPath,
      size: 0,
      fileCount: 0,
      children: [],
    };
    dirIndex.set(dirPath, node);

    const parentPath = dirPath.includes('/') ? dirPath.slice(0, dirPath.lastIndexOf('/')) : '';
    ensureDir(parentPath).children.push(node);
    return node;
  }

  for (const dirPath of emptyDirs) ensureDir(dirPath);

  for (const file of files) {
    for (const ancestor of ancestorsOf(file.path)) ensureDir(ancestor);

    const parentPath = file.path.includes('/')
      ? file.path.slice(0, file.path.lastIndexOf('/'))
      : '';
    ensureDir(parentPath).children.push({
      type: 'file',
      name: basenameOf(file.path),
      path: file.path,
      size: file.size,
      id: file.id,
    });

    // Roll the size up through every ancestor, including root.
    let cursor: string | null = parentPath;
    while (cursor !== null) {
      const node = dirIndex.get(cursor);
      if (node) {
        node.size += file.size;
        node.fileCount += 1;
      }
      if (cursor === '') break;
      cursor = cursor.includes('/') ? cursor.slice(0, cursor.lastIndexOf('/')) : '';
    }
  }

  sortChildren(root);
  return root.children;
}

/** Folders first, then files, each alphabetically — how a file manager shows it. */
function sortChildren(node: TreeDir): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  for (const child of node.children) {
    if (child.type === 'dir') sortChildren(child);
  }
}
