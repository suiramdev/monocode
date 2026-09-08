import { beforeEach, describe, expect, it } from "vitest";
import {
  clearWorktreeScripts,
  EMPTY_WORKTREE_SCRIPTS,
  loadWorktreeScripts,
  saveWorktreeScripts,
  worktreeScriptEnv,
  worktreeScriptFailure,
} from "./worktreeScripts";

const PROJECT = "/Users/dev/projects/widget";

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
      clear: () => {
        data.clear();
      },
    },
  });
}

describe("worktree scripts storage", () => {
  beforeEach(mockLocalStorage);

  it("keeps scripts per project and trims them", () => {
    saveWorktreeScripts(PROJECT, {
      setup: "  npm install\n",
      teardown: "docker compose down",
    });
    expect(loadWorktreeScripts(PROJECT)).toEqual({
      setup: "npm install",
      teardown: "docker compose down",
    });
    expect(loadWorktreeScripts("/Users/dev/projects/other")).toEqual(
      EMPTY_WORKTREE_SCRIPTS,
    );
  });

  it("reads back through a trailing slash on the same project", () => {
    saveWorktreeScripts(PROJECT, { setup: "npm ci", teardown: "" });
    expect(loadWorktreeScripts(`${PROJECT}/`).setup).toBe("npm ci");
  });

  it("stores nothing once both scripts are blank", () => {
    saveWorktreeScripts(PROJECT, { setup: "npm ci", teardown: "" });
    saveWorktreeScripts(PROJECT, { setup: "  ", teardown: "\n" });
    expect(localStorage.getItem("monocode:worktree-scripts")).toBe("{}");
    expect(loadWorktreeScripts(PROJECT)).toEqual(EMPTY_WORKTREE_SCRIPTS);
  });

  it("drops one project without touching another", () => {
    saveWorktreeScripts(PROJECT, { setup: "a", teardown: "" });
    saveWorktreeScripts("/Users/dev/projects/other", {
      setup: "b",
      teardown: "",
    });
    clearWorktreeScripts(PROJECT);
    expect(loadWorktreeScripts(PROJECT).setup).toBe("");
    expect(loadWorktreeScripts("/Users/dev/projects/other").setup).toBe("b");
  });

  it("survives a corrupt entry", () => {
    localStorage.setItem("monocode:worktree-scripts", "not json");
    expect(loadWorktreeScripts(PROJECT)).toEqual(EMPTY_WORKTREE_SCRIPTS);
  });
});

describe("worktreeScriptEnv", () => {
  it("hands the script its event, folders and branch", () => {
    expect(
      worktreeScriptEnv("teardown", {
        project: PROJECT,
        worktree: "/Users/dev/.monocode/worktrees/widget/alpha",
        branch: "feat/alpha",
      }),
    ).toEqual({
      MONOCODE_EVENT: "teardown",
      MONOCODE_PROJECT_DIR: PROJECT,
      MONOCODE_WORKTREE_DIR: "/Users/dev/.monocode/worktrees/widget/alpha",
      MONOCODE_WORKTREE_NAME: "alpha",
      MONOCODE_WORKTREE_BRANCH: "feat/alpha",
    });
  });

  it("passes an empty branch for a detached worktree", () => {
    expect(
      worktreeScriptEnv("setup", { project: PROJECT, worktree: "/wt/alpha" })
        .MONOCODE_WORKTREE_BRANCH,
    ).toBe("");
  });
});

describe("worktreeScriptFailure", () => {
  it("names the script, the code and the last of its output", () => {
    expect(
      worktreeScriptFailure("setup", {
        code: 2,
        stdout: "one\ntwo\nthree\nfour\nfive\nsix",
        stderr: "",
      }),
    ).toBe("Setup script failed with exit code 2.\nthree\nfour\nfive\nsix");
  });

  it("prefers stderr, and says only the code when nothing was printed", () => {
    expect(
      worktreeScriptFailure("teardown", {
        code: 1,
        stdout: "noise",
        stderr: "boom",
      }),
    ).toBe("Teardown script failed with exit code 1.\nboom");
    expect(
      worktreeScriptFailure("teardown", { code: 1, stdout: "", stderr: "" }),
    ).toBe("Teardown script failed with exit code 1.");
  });
});
