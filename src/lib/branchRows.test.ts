import { describe, expect, it } from "vitest";
import { buildBranchRows, type BranchRow } from "./branchRows";
import type { GitBranchInfo } from "./fs";

function branch(name: string, remote: string | null = null): GitBranchInfo {
  return { name, current: false, remote };
}

function build(overrides: {
  branches?: GitBranchInfo[];
  query?: string;
  selected?: string | null;
}): BranchRow[] {
  return buildBranchRows({
    branches: overrides.branches ?? [],
    query: overrides.query ?? "",
    selected: overrides.selected ?? "main",
  });
}

describe("buildBranchRows", () => {
  it("marks the selected branch and offers nothing to create", () => {
    expect(build({ branches: [branch("main"), branch("feat/ship")] })).toEqual([
      { kind: "branch", branch: { name: "main", current: true, remote: null } },
      {
        kind: "branch",
        branch: { name: "feat/ship", current: false, remote: null },
      },
    ]);
  });

  it("creates the typed name unless a local branch already has it", () => {
    expect(build({ branches: [branch("main")], query: "feat/new" })).toEqual([
      { kind: "create", name: "feat/new" },
    ]);
    expect(build({ branches: [branch("main")], query: "main" })).toEqual([
      { kind: "branch", branch: { name: "main", current: true, remote: null } },
    ]);
  });

  it("offers to create a name only a remote branch has", () => {
    expect(
      build({
        branches: [branch("main"), branch("feat/ship", "origin")],
        query: "feat/ship",
      }),
    ).toEqual([
      { kind: "create", name: "feat/ship" },
      {
        kind: "branch",
        branch: { name: "feat/ship", current: false, remote: "origin" },
      },
    ]);
  });

  it("filters branches by name and remote", () => {
    const branches = [
      branch("main"),
      branch("feat/ship"),
      branch("hotfix", "upstream"),
    ];
    expect(build({ branches, query: "ship" })).toEqual([
      { kind: "create", name: "ship" },
      {
        kind: "branch",
        branch: { name: "feat/ship", current: false, remote: null },
      },
    ]);
    expect(build({ branches, query: "upstream" })).toEqual([
      { kind: "create", name: "upstream" },
      {
        kind: "branch",
        branch: { name: "hotfix", current: false, remote: "upstream" },
      },
    ]);
  });
});
