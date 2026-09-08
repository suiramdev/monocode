import { afterEach, describe, expect, it, vi } from "vitest";
import {
  tearDownWorktree,
  TEARDOWN_REMOVE_STATUS,
  TEARDOWN_SCRIPT_STATUS,
  type WorktreeTeardownProgress,
} from "./worktreeTeardown";
import type * as WorktreeScriptsModule from "./worktreeScripts";

const gitWorktreeRemove = vi.fn();
const notifyGitChanged = vi.fn();
const runWorktreeScript = vi.fn();

vi.mock("./fs", () => ({
  gitWorktreeRemove: (...args: unknown[]) => gitWorktreeRemove(...args),
  notifyGitChanged: () => notifyGitChanged(),
}));

vi.mock("./worktreeScripts", async () => {
  const actual = await vi.importActual<typeof WorktreeScriptsModule>(
    "./worktreeScripts",
  );
  return {
    ...actual,
    runWorktreeScript: (...args: unknown[]) => runWorktreeScript(...args),
  };
});

const TARGET = {
  project: "/repo",
  worktree: "/wt/alpha",
  branch: "alpha",
  script: true,
  scriptDone: false,
};

function run(
  overrides: Partial<typeof TARGET> = {},
  force = false,
): Promise<WorktreeTeardownProgress[]> {
  const seen: WorktreeTeardownProgress[] = [];
  return tearDownWorktree({ ...TARGET, ...overrides }, force, (progress) =>
    seen.push(progress),
  ).then(() => seen);
}

describe("tearDownWorktree", () => {
  afterEach(() => {
    gitWorktreeRemove.mockReset();
    notifyGitChanged.mockReset();
    runWorktreeScript.mockReset();
  });

  it("runs the script, then removes the worktree", async () => {
    runWorktreeScript.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    gitWorktreeRemove.mockResolvedValue(undefined);

    const seen = await run();
    expect(seen.map((step) => step.status)).toEqual([
      TEARDOWN_SCRIPT_STATUS,
      TEARDOWN_REMOVE_STATUS,
      null,
    ]);
    expect(seen.at(-1)).toEqual({
      status: null,
      scriptDone: true,
      error: null,
      done: true,
    });
    expect(runWorktreeScript).toHaveBeenCalledWith("teardown", {
      ...TARGET,
    });
    expect(gitWorktreeRemove).toHaveBeenCalledWith("/repo", "/wt/alpha", false);
    expect(notifyGitChanged).toHaveBeenCalledTimes(1);
  });

  it("skips the script when the project has none", async () => {
    gitWorktreeRemove.mockResolvedValue(undefined);
    const seen = await run({ script: false });
    expect(runWorktreeScript).not.toHaveBeenCalled();
    expect(seen[0]?.status).toBe(TEARDOWN_REMOVE_STATUS);
    expect(seen.at(-1)?.done).toBe(true);
  });

  it("keeps the worktree when the script fails, and says why", async () => {
    runWorktreeScript.mockResolvedValue({
      code: 2,
      stdout: "",
      stderr: "compose down failed",
    });
    const seen = await run();
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(notifyGitChanged).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual({
      status: null,
      scriptDone: true,
      error:
        "Teardown script failed with exit code 2.\ncompose down failed",
      done: false,
    });
  });

  it("reports a script that could not be started at all", async () => {
    runWorktreeScript.mockRejectedValue(new Error("The script is empty."));
    const seen = await run();
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(seen.at(-1)).toMatchObject({
      error: "The script is empty.",
      scriptDone: true,
      done: false,
    });
  });

  it("retries the removal with force and leaves the script alone", async () => {
    gitWorktreeRemove.mockRejectedValueOnce(
      new Error("contains modified or untracked files, use --force to delete"),
    );
    const first = await run({ scriptDone: true });
    expect(runWorktreeScript).not.toHaveBeenCalled();
    expect(first.at(-1)?.error).toContain("use --force");
    expect(first.at(-1)?.done).toBe(false);

    gitWorktreeRemove.mockResolvedValueOnce(undefined);
    const retry = await run({ scriptDone: true }, true);
    expect(runWorktreeScript).not.toHaveBeenCalled();
    expect(gitWorktreeRemove).toHaveBeenLastCalledWith(
      "/repo",
      "/wt/alpha",
      true,
    );
    expect(retry.at(-1)?.done).toBe(true);
  });
});
