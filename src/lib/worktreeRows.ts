import { basename, type GitBranchInfo, type GitWorktreeInfo } from "./fs";
import { sameProjectPath } from "./recents";

export type WorktreeRow =
  /** Name typed in the field: a fresh worktree, or one for a branch of that name. */
  | { kind: "create"; name: string; exists: boolean }
  /** The project checkout itself, where a session runs with no worktree. */
  | { kind: "project"; path: string; current: boolean }
  | {
      kind: "worktree";
      worktree: GitWorktreeInfo;
      /** Holds the selected branch, or was cut from it. */
      related: boolean;
      current: boolean;
    };

/**
 * Rows of the composer worktree picker. Worktrees for the selected branch come
 * first — the ones holding it and the ones cut from it — then the rest of the
 * repository's worktrees, so no working copy is unreachable.
 */
export function buildWorktreeRows(input: {
  worktrees: GitWorktreeInfo[];
  branches: GitBranchInfo[];
  /** Project checkout of the session; its worktree is shown as the project row. */
  projectCwd: string;
  /** Worktree the session runs in, or null for the project checkout. */
  currentPath: string | null;
  /** Branch the session works on. */
  branch: string | null;
  /** Name a new worktree takes while the field is empty. */
  suggested: string;
  query: string;
}): WorktreeRow[] {
  const { worktrees, branches, projectCwd, currentPath, branch } = input;
  const typed = input.query.trim();
  const needle = typed.toLowerCase();
  const linked = worktrees.filter(
    (worktree) => !sameProjectPath(worktree.path, projectCwd),
  );
  const name = typed || input.suggested.trim();
  const held = linked.some((worktree) => worktree.branch === name);

  const rows: WorktreeRow[] = [];
  if (name && !held) {
    rows.push({
      kind: "create",
      name,
      exists: branches.some((entry) => entry.name === name),
    });
  }
  if (!needle || "project".includes(needle) || matches(projectCwd, needle)) {
    rows.push({
      kind: "project",
      path: projectCwd,
      current: !currentPath || sameProjectPath(currentPath, projectCwd),
    });
  }
  const listed = linked
    .map((worktree) => ({
      kind: "worktree" as const,
      worktree,
      related:
        !!branch && (worktree.branch === branch || worktree.base === branch),
      current: !!currentPath && sameProjectPath(worktree.path, currentPath),
    }))
    .filter(
      (row) =>
        !needle ||
        matches(basename(row.worktree.path), needle) ||
        matches(row.worktree.branch ?? row.worktree.head, needle) ||
        matches(row.worktree.path, needle),
    );
  for (const row of listed) if (row.related) rows.push(row);
  for (const row of listed) if (!row.related) rows.push(row);
  return rows;
}

function matches(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle);
}

const NAME_LIMIT = 999;

/**
 * Name offered when the field is empty: the selected branch with a counter, and
 * never a name git already resolves, so it always means a new working copy.
 * A branch that already ends in a counter continues that series rather than
 * stacking another one, so `alpha-2` suggests `alpha-3`, not `alpha-2-2`.
 */
export function suggestWorktreeName(
  branch: string | null,
  branches: GitBranchInfo[],
): string {
  const slug = (branch ?? "")
    .replace(/\//g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-\d+$/, "");
  const stem = slug || "worktree";
  const taken = new Set(branches.map((entry) => entry.name.toLowerCase()));
  for (let index = 2; index <= NAME_LIMIT; index += 1) {
    const candidate = `${stem}-${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}`;
}
