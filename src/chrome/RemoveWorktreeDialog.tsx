import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { basename, gitDiffStats } from "../lib/fs";
import { LAYER } from "../lib/layers";
import { prettyCwd } from "../lib/paths";
import { Loader } from "./icons";

export type RemoveWorktreeStage = "ask" | "working";

type Props = {
  /** Worktree the session ran in. */
  worktree: string;
  branch?: string;
  /** Wording for what is happening to the conversation itself. */
  mode: "archive" | "delete";
  /** True when the project has a teardown script to run first. */
  script: boolean;
  stage: RemoveWorktreeStage;
  status: string | null;
  error: string | null;
  onKeep: () => void;
  /** `force` lets git drop a worktree that still holds changes. */
  onRemove: (force: boolean) => void;
  onCancel: () => void;
};

/**
 * Asked once a worktree session is torn down: the conversation is going, and
 * its working copy either goes with it or stays for later. Removal runs the
 * project's teardown script first, so failures land back in this dialog.
 */
export function RemoveWorktreeDialog({
  worktree,
  branch,
  mode,
  script,
  stage,
  status,
  error,
  onKeep,
  onRemove,
  onCancel,
}: Props) {
  const [changed, setChanged] = useState<number | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const name = basename(worktree);

  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void gitDiffStats(worktree)
      .then((stats) => {
        if (!cancelled) setChanged(stats.files);
      })
      .catch(() => {
        if (!cancelled) setChanged(null);
      });
    return () => {
      cancelled = true;
    };
  }, [worktree]);

  const dirty = (changed ?? 0) > 0;
  const working = stage === "working";
  // Work in flight owns the dialog; a failure hands it back to the user.
  const locked = working && !error;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || locked) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, locked]);

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: LAYER.dialog }}>
      <div
        className="absolute inset-0 bg-black/30"
        onMouseDown={locked ? undefined : onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Remove the worktree ${name}`}
        onMouseDown={(event) => event.stopPropagation()}
        className="absolute left-1/2 top-[22%] flex w-[min(440px,calc(100vw-24px))] -translate-x-1/2 flex-col gap-3 rounded-lg border border-content/10 bg-content/5 p-4 shadow-xl backdrop-blur-xl"
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-[13px] font-medium leading-tight text-content">
            Remove the worktree “{name}”?
          </h2>
          <p className="text-[12px] leading-snug text-content/55">
            {mode === "archive"
              ? "Archiving this conversation leaves its working copy on disk."
              : "Deleting this conversation leaves its working copy on disk."}{" "}
            {script
              ? "Removing it runs the project's teardown script first, then drops the folder."
              : "Removing it drops the folder."}{" "}
            The branch stays either way.
          </p>
          {dirty ? (
            <p className="text-[12px] leading-snug text-amber-300/80">
              {changed === 1
                ? "1 file has uncommitted changes that removal discards."
                : `${changed} files have uncommitted changes that removal discards.`}
            </p>
          ) : null}
          <p className="truncate text-[11px] leading-tight text-content/40">
            {prettyCwd(worktree)}
            {branch ? ` · ${branch}` : ""}
          </p>
        </div>

        {working && status ? (
          <p className="flex items-center gap-2 text-[12px] text-content/60">
            <Loader
              className="size-3.5 shrink-0 animate-spin"
              strokeWidth={1.75}
              aria-hidden
            />
            <span className="min-w-0 truncate">{status}</span>
          </p>
        ) : null}
        {error ? (
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-red-400/20 bg-red-400/5 px-2.5 py-2 font-mono text-[11px] leading-4 text-red-300/90">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          {working ? null : (
            <button
              type="button"
              onClick={onCancel}
              className="mr-auto rounded-md px-3 py-1.5 text-[12px] text-content/50 hover:bg-content/8 hover:text-content"
            >
              {mode === "archive" ? "Don’t archive" : "Don’t delete"}
            </button>
          )}
          <button
            ref={keepRef}
            type="button"
            disabled={locked}
            onClick={onKeep}
            className="rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Keep worktree
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => onRemove(dirty || Boolean(error))}
            className="rounded-md bg-red-500/20 px-3 py-1.5 text-[12px] font-medium text-red-300 hover:bg-red-500/30 disabled:opacity-40 disabled:hover:bg-red-500/20"
          >
            {error
              ? "Remove anyway"
              : dirty
                ? "Discard and remove"
                : "Remove worktree"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
