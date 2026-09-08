import type { GitBranchInfo, GitWorktreeInfo } from "./fs";
import { sameProjectPath } from "./recents";

export type BranchRow =
  | { kind: "create"; name: string }
  | { kind: "create-worktree"; name: string; exists: boolean }
  | { kind: "worktree"; worktree: GitWorktreeInfo }
  | { kind: "branch"; branch: GitBranchInfo };

/**
 * Rows of the composer branch picker. A branch held by another worktree is
 * listed as that worktree instead of a branch: git refuses to check out a
 * branch a sibling worktree already holds.
 */
export function buildBranchRows(input: {
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
  query: string;
  selected: string | null;
  workCwd: string;
  allowWorktrees: boolean;
}): BranchRow[] {
  const { branches, selected, workCwd, allowWorktrees } = input;
  const worktrees = allowWorktrees ? input.worktrees : [];
  const name = input.query.trim();
  const needle = name.toLowerCase();
  const taken = branches.some((entry) => !entry.remote && entry.name === name);
  const matchesExisting = branches.some((entry) => entry.name === name);
  const elsewhere = worktrees.filter(
    (worktree) => !sameProjectPath(worktree.path, workCwd),
  );
  const heldElsewhere = new Set(
    elsewhere
      .map((worktree) => worktree.branch)
      .filter((branch): branch is string => !!branch),
  );
  const alreadyCheckedOut = worktrees.some(
    (worktree) => worktree.branch === name,
  );

  const rows: BranchRow[] = [];
  if (name && !taken) rows.push({ kind: "create", name });
  if (allowWorktrees && name && !alreadyCheckedOut) {
    rows.push({ kind: "create-worktree", name, exists: matchesExisting });
  }
  for (const worktree of elsewhere) {
    const hay = `${worktree.branch ?? worktree.head} ${worktree.path}`;
    if (needle && !hay.toLowerCase().includes(needle)) continue;
    rows.push({ kind: "worktree", worktree });
  }
  for (const entry of branches) {
    const hay = entry.remote ? `${entry.name} ${entry.remote}` : entry.name;
    if (needle && !hay.toLowerCase().includes(needle)) continue;
    if (heldElsewhere.has(entry.name)) continue;
    rows.push({
      kind: "branch",
      branch: { ...entry, current: entry.name === selected && !entry.remote },
    });
  }
  return rows;
}
