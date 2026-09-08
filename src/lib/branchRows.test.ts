import { describe, expect, it } from "vitest";
import { buildBranchRows, type BranchRow } from "./branchRows";
import type { GitBranchInfo, GitWorktreeInfo } from "./fs";

function branch(
  name: string,
  remote: string | null = null,
): GitBranchInfo {
  return { name, current: false, remote };
}

function worktree(
  path: string,
  branchName: string | null,
  main = false,
): GitWorktreeInfo {
  return { path, branch: branchName, head: "abc1234", main };
}

function build(overrides: {
  branches?: GitBranchInfo[];
  worktrees?: GitWorktreeInfo[];
  query?: string;
  selected?: string | null;
  workCwd?: string;
  allowWorktrees?: boolean;
}): BranchRow[] {
  return buildBranchRows({
    branches: overrides.branches ?? [],
    worktrees: overrides.worktrees ?? [],
    query: overrides.query ?? "",
    selected: overrides.selected ?? "main",
    workCwd: overrides.workCwd ?? "/tmp/repo",
    allowWorktrees: overrides.allowWorktrees ?? true,
  });
}

describe("buildBranchRows", () => {
  it("offers no worktree row without a name to create", () => {
    const rows = build({
      branches: [branch("main")],
      worktrees: [worktree("/tmp/repo", "main", true)],
    });
    expect(rows.some((row) => row.kind === "create-worktree")).toBe(false);
    expect(rows).toEqual([
      { kind: "branch", branch: { name: "main", current: true, remote: null } },
    ]);
  });

  it("creates a new branch in a worktree, or opens an existing one", () => {
    const fresh = build({
      branches: [branch("main")],
      query: "feat/new",
    });
    expect(fresh).toEqual([
      { kind: "create", name: "feat/new" },
      { kind: "create-worktree", name: "feat/new", exists: false },
    ]);

    const remoteOnly = build({
      branches: [branch("main"), branch("feat/ship", "origin")],
      query: "feat/ship",
    });
    expect(remoteOnly).toEqual([
      { kind: "create", name: "feat/ship" },
      { kind: "create-worktree", name: "feat/ship", exists: true },
      {
        kind: "branch",
        branch: { name: "feat/ship", current: false, remote: "origin" },
      },
    ]);
  });

  it("lists a branch held by another worktree once, as a worktree", () => {
    const rows = build({
      branches: [branch("main"), branch("feat/wt"), branch("feat/wt", "origin")],
      worktrees: [
        worktree("/tmp/repo", "main", true),
        worktree("/tmp/wt/feat-wt", "feat/wt"),
      ],
    });
    expect(rows).toEqual([
      { kind: "worktree", worktree: worktree("/tmp/wt/feat-wt", "feat/wt") },
      { kind: "branch", branch: { name: "main", current: true, remote: null } },
    ]);
  });

  it("hides the worktree the session already runs in", () => {
    const rows = build({
      branches: [],
      worktrees: [
        worktree("/tmp/repo", "main", true),
        worktree("/tmp/wt/feat-a", "feat/a"),
      ],
      workCwd: "/tmp/wt/feat-a",
    });
    expect(rows).toEqual([
      { kind: "worktree", worktree: worktree("/tmp/repo", "main", true) },
    ]);
  });

  it("filters worktrees by path as well as branch", () => {
    const rows = build({
      branches: [],
      worktrees: [
        worktree("/tmp/wt/alpha", "one"),
        worktree("/tmp/other/beta", "two"),
      ],
      query: "other",
    });
    expect(rows).toEqual([
      { kind: "create", name: "other" },
      { kind: "create-worktree", name: "other", exists: false },
      { kind: "worktree", worktree: worktree("/tmp/other/beta", "two") },
    ]);
  });
});
