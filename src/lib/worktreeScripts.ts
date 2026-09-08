import { invoke } from "@tauri-apps/api/core";
import { basename } from "./fs";
import { projectKey } from "./paths";
import { normalizeProjectPath } from "./recents";

/**
 * Per-project shell scripts around a worktree's life. Setup runs once, in a
 * worktree MonoCode just created; teardown runs in the worktree right before
 * MonoCode removes it. Reusing an existing worktree runs neither.
 */
export type WorktreeScripts = {
  setup: string;
  teardown: string;
};

export type WorktreeScriptKind = keyof WorktreeScripts;

export const EMPTY_WORKTREE_SCRIPTS: WorktreeScripts = {
  setup: "",
  teardown: "",
};

const KEY = "monocode:worktree-scripts";

function read(): Record<string, Partial<WorktreeScripts>> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, Partial<WorktreeScripts>>)
      : {};
  } catch {
    return {};
  }
}

function write(value: Record<string, Partial<WorktreeScripts>>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // private mode / quota
  }
}

function keyFor(project: string): string {
  return projectKey(normalizeProjectPath(project));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function loadWorktreeScripts(project: string): WorktreeScripts {
  const stored = read()[keyFor(project)];
  if (!stored) return EMPTY_WORKTREE_SCRIPTS;
  return { setup: text(stored.setup), teardown: text(stored.teardown) };
}

/** Blank scripts drop the entry, so an untouched project stores nothing. */
export function saveWorktreeScripts(project: string, value: WorktreeScripts) {
  const all = read();
  const key = keyFor(project);
  const setup = value.setup.trim();
  const teardown = value.teardown.trim();
  if (!setup && !teardown) delete all[key];
  else all[key] = { setup, teardown };
  write(all);
}

export function clearWorktreeScripts(project: string) {
  const all = read();
  delete all[keyFor(project)];
  write(all);
}

export type WorktreeScriptRun = {
  code: number;
  stdout: string;
  stderr: string;
};

export type WorktreeScriptTarget = {
  project: string;
  worktree: string;
  branch?: string;
};

/** What a script sees, so it can copy secrets in or tear services down. */
export function worktreeScriptEnv(
  kind: WorktreeScriptKind,
  target: WorktreeScriptTarget,
): Record<string, string> {
  return {
    MONOCODE_EVENT: kind,
    MONOCODE_PROJECT_DIR: target.project,
    MONOCODE_WORKTREE_DIR: target.worktree,
    MONOCODE_WORKTREE_NAME: basename(target.worktree),
    MONOCODE_WORKTREE_BRANCH: target.branch ?? "",
  };
}

/**
 * Run the project's script for `kind` inside the worktree. Resolves to null
 * when the project has no script for it, so callers can skip the whole step.
 */
export async function runWorktreeScript(
  kind: WorktreeScriptKind,
  target: WorktreeScriptTarget,
): Promise<WorktreeScriptRun | null> {
  const script = loadWorktreeScripts(target.project)[kind].trim();
  if (!script) return null;
  return invoke<WorktreeScriptRun>("run_worktree_script", {
    script,
    cwd: target.worktree,
    env: worktreeScriptEnv(kind, target),
  });
}

/** One line for a failed run: the exit code plus the tail of what it printed. */
export function worktreeScriptFailure(
  kind: WorktreeScriptKind,
  run: WorktreeScriptRun,
): string {
  const label = kind === "setup" ? "Setup script" : "Teardown script";
  const output = (run.stderr.trim() || run.stdout.trim()).split("\n");
  const tail = output.slice(-4).join("\n").trim();
  const head = `${label} failed with exit code ${run.code}.`;
  return tail ? `${head}\n${tail}` : head;
}
