import { describe, expect, it } from "vitest";
import {
  buildWorktreeRows,
  suggestWorktreeName,
  type WorktreeRow,
} from "./worktreeRows";
import type { GitBranchInfo, GitWorktreeInfo } from "./fs";

function worktree(
  path: string,
  branch: string | null,
  extra: { base?: string | null; main?: boolean } = {},
): GitWorktreeInfo {
  return {
    path,
    branch,
    head: "abc1234",
    main: extra.main ?? false,
    base: extra.base ?? null,
  };
}

function branch(name: string, remote: string | null = null): GitBranchInfo {
  return { name, current: false, remote };
}

const PROJECT = "/tmp/repo";
const MAIN = worktree(PROJECT, "main", { main: true });

function build(overrides: {
  worktrees?: GitWorktreeInfo[];
  branches?: GitBranchInfo[];
  currentPath?: string | null;
  branch?: string | null;
  suggested?: string;
  query?: string;
}): WorktreeRow[] {
  return buildWorktreeRows({
    worktrees: overrides.worktrees ?? [MAIN],
    branches: overrides.branches ?? [],
    projectCwd: PROJECT,
    currentPath: overrides.currentPath ?? null,
    branch: overrides.branch === undefined ? "main" : overrides.branch,
    suggested: overrides.suggested ?? "main-2",
    query: overrides.query ?? "",
  });
}

describe("buildWorktreeRows", () => {
  it("offers the generated name and the project checkout with an empty field", () => {
    expect(build({})).toEqual([
      { kind: "create", name: "main-2", exists: false },
      { kind: "project", path: PROJECT, current: true },
    ]);
  });

  it("puts worktrees of the selected branch before the others", () => {
    const holding = worktree("/wt/main", "main");
    const cut = worktree("/wt/alpha", "alpha", { base: "main" });
    const other = worktree("/wt/beta", "beta", { base: "release" });
    const rows = build({
      worktrees: [MAIN, other, cut, holding],
      currentPath: "/wt/alpha",
    });
    expect(rows).toEqual([
      { kind: "create", name: "main-2", exists: false },
      { kind: "project", path: PROJECT, current: false },
      { kind: "worktree", worktree: cut, related: true, current: true },
      { kind: "worktree", worktree: holding, related: true, current: false },
      { kind: "worktree", worktree: other, related: false, current: false },
    ]);
  });

  it("relates nothing while the branch is unknown", () => {
    const rows = build({
      worktrees: [MAIN, worktree("/wt/alpha", "alpha", { base: "main" })],
      branch: null,
    });
    expect(rows.filter((row) => row.kind === "worktree")).toEqual([
      {
        kind: "worktree",
        worktree: worktree("/wt/alpha", "alpha", { base: "main" }),
        related: false,
        current: false,
      },
    ]);
  });

  it("offers the typed name, and says when a branch already has it", () => {
    expect(build({ query: "alpha" })[0]).toEqual({
      kind: "create",
      name: "alpha",
      exists: false,
    });
    expect(
      build({ query: "feat/ship", branches: [branch("feat/ship", "origin")] })[0],
    ).toEqual({ kind: "create", name: "feat/ship", exists: true });
  });

  it("drops the create row for a branch a worktree already holds", () => {
    const rows = build({
      worktrees: [MAIN, worktree("/wt/alpha", "alpha")],
      query: "alpha",
    });
    expect(rows.some((row) => row.kind === "create")).toBe(false);
    // Same for the generated name, so it never offers a worktree that exists.
    expect(
      build({
        worktrees: [MAIN, worktree("/wt/main-2", "main-2")],
        suggested: "main-2",
      }).some((row) => row.kind === "create"),
    ).toBe(false);
  });

  it("filters by folder name, branch and path", () => {
    const worktrees = [MAIN, worktree("/wt/alpha", "feat/ship")];
    for (const query of ["alpha", "ship", "/wt/"]) {
      expect(build({ worktrees, query }).at(-1)).toMatchObject({
        kind: "worktree",
        worktree: { path: "/wt/alpha" },
      });
    }
    expect(build({ worktrees, query: "zzz" })).toEqual([
      { kind: "create", name: "zzz", exists: false },
    ]);
  });
});

describe("suggestWorktreeName", () => {
  it("counts up from the branch slug past every taken name", () => {
    expect(suggestWorktreeName("feat/ship", [])).toBe("feat-ship-2");
    expect(
      suggestWorktreeName("main", [
        branch("main-2"),
        branch("main-3", "origin"),
      ]),
    ).toBe("main-4");
  });

  it("continues a counter the branch already carries", () => {
    expect(suggestWorktreeName("alpha-2", [branch("alpha"), branch("alpha-2")]))
      .toBe("alpha-3");
  });

  it("names a worktree with no branch to grow from", () => {
    expect(suggestWorktreeName(null, [])).toBe("worktree-2");
  });
});
