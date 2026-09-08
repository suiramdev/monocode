import { gitWorktreeRemove, notifyGitChanged } from "./fs";
import {
  runWorktreeScript,
  worktreeScriptFailure,
  type WorktreeScriptTarget,
} from "./worktreeScripts";

export type WorktreeTeardownTarget = WorktreeScriptTarget & {
  /** The project has a teardown script for this worktree. */
  script: boolean;
  /** The script already ran, so a retry must not run it twice. */
  scriptDone: boolean;
};

export type WorktreeTeardownProgress = {
  /** Step in flight, or null once it finished or failed. */
  status: string | null;
  scriptDone: boolean;
  error: string | null;
  /** The worktree is gone; nothing is left to report. */
  done: boolean;
};

export const TEARDOWN_SCRIPT_STATUS = "Running the teardown script…";
export const TEARDOWN_REMOVE_STATUS = "Removing the worktree…";

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run the project's teardown script, then drop the worktree, reporting each
 * step. A failure stops before the next one and comes back with `error`; the
 * retry resumes from `scriptDone` instead of running the script again.
 */
export async function tearDownWorktree(
  target: WorktreeTeardownTarget,
  force: boolean,
  report: (progress: WorktreeTeardownProgress) => void,
): Promise<void> {
  let scriptDone = target.scriptDone;
  const fail = (error: string) =>
    report({ status: null, scriptDone, error, done: false });

  if (target.script && !scriptDone) {
    report({
      status: TEARDOWN_SCRIPT_STATUS,
      scriptDone,
      error: null,
      done: false,
    });
    try {
      const run = await runWorktreeScript("teardown", target);
      // The script has had its turn either way: a retry is about the removal.
      scriptDone = true;
      if (run && run.code !== 0) {
        fail(worktreeScriptFailure("teardown", run));
        return;
      }
    } catch (error) {
      scriptDone = true;
      fail(detail(error));
      return;
    }
  }

  report({
    status: TEARDOWN_REMOVE_STATUS,
    scriptDone,
    error: null,
    done: false,
  });
  try {
    await gitWorktreeRemove(target.project, target.worktree, force);
  } catch (error) {
    fail(detail(error));
    return;
  }
  notifyGitChanged();
  report({ status: null, scriptDone, error: null, done: true });
}
