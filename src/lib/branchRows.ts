import type { GitBranchInfo } from "./fs";

export type BranchRow =
  | { kind: "create"; name: string }
  | { kind: "branch"; branch: GitBranchInfo };

/**
 * Rows of the composer branch picker: the branches matching the query, plus the
 * typed name when no local branch has it yet. Which working copy the branch is
 * checked out in is the worktree picker's business, not this list's.
 */
export function buildBranchRows(input: {
  branches: GitBranchInfo[];
  query: string;
  selected: string | null;
}): BranchRow[] {
  const { branches, selected } = input;
  const name = input.query.trim();
  const needle = name.toLowerCase();
  const taken = branches.some((entry) => !entry.remote && entry.name === name);

  const rows: BranchRow[] = [];
  if (name && !taken) rows.push({ kind: "create", name });
  for (const entry of branches) {
    const hay = entry.remote ? `${entry.name} ${entry.remote}` : entry.name;
    if (needle && !hay.toLowerCase().includes(needle)) continue;
    rows.push({
      kind: "branch",
      branch: { ...entry, current: entry.name === selected && !entry.remote },
    });
  }
  return rows;
}
