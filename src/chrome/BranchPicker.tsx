import {
  Check,
  Folder,
  FolderPlus,
  GitBranch,
  Plus,
  Search,
} from "./icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitStageAll,
  gitStash,
  gitWorktreeAdd,
  gitWorktrees,
  isCheckoutBlockedByChanges,
  notifyGitChanged,
  type GitWorktreeInfo,
} from "../lib/fs";
import { buildBranchRows, type BranchRow } from "../lib/branchRows";
import { prettyCwd } from "../lib/paths";
import { loadWorktreeRoot } from "../lib/settings";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useProjectBranchesState } from "../hooks/useProjectBranches";
import { Popover } from "./Popover";
import { SwitchBranchDialog } from "./SwitchBranchDialog";

type Props = {
  cwd: string;
  branch?: string;
  worktreePath?: string;
  enabled?: boolean;
  onChange?: (branch: string) => void;
  onWorktree?: (target: { path: string; branch: string }) => void;
  onClose?: () => void;
};

const MENU_WIDTH = 280;

type PendingSwitch =
  | { kind: "create"; name: string }
  | { kind: "checkout"; name: string; remote: string | null };

const MENU_MIN_HEIGHT = 180;
const MENU_MAX_HEIGHT = 280;

export function BranchPicker({
  cwd,
  branch,
  worktreePath,
  enabled = true,
  onChange,
  onWorktree,
  onClose,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<PendingSwitch | null>(null);
  const [blockedError, setBlockedError] = useState<string | null>(null);
  const [blockedBusy, setBlockedBusy] = useState<"stash" | "commit" | null>(
    null,
  );
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWorktreeRef = useRef(onWorktree);
  onWorktreeRef.current = onWorktree;
  const allowWorktrees = Boolean(onWorktree);

  const inProject = Boolean(cwd) && cwd !== "~";
  const { branches: projectBranches, settled: branchesSettled } =
    useProjectBranchesState(cwd, inProject);

  const current = branch || projectBranches?.current || null;
  const detached = !branch && !!projectBranches?.detached;

  const dismiss = (restore: boolean) => {
    setOpen(false);
    setQuery("");
    setError(null);
    setBusy(false);
    setBlocked(null);
    setBlockedError(null);
    setBlockedBusy(null);
    if (restore) onCloseRef.current?.();
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setActive(0);
  }, [open]);

  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);

  // Worktrees only matter while the menu is open, and `git worktree list`
  // shells out — load it on open rather than with every branch refresh.
  useEffect(() => {
    if (!open || !allowWorktrees) return;
    let cancelled = false;
    void gitWorktrees(cwd)
      .then((list) => {
        if (!cancelled) setWorktrees(list);
      })
      .catch(() => {
        if (!cancelled) setWorktrees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [allowWorktrees, cwd, open]);

  useEffect(() => {
    if (enabled) return;
    setOpen(false);
    setQuery("");
    setError(null);
    setBusy(false);
    setBlocked(null);
    setBlockedError(null);
    setBlockedBusy(null);
  }, [enabled]);

  const rows = useMemo(
    () =>
      buildBranchRows({
        branches: projectBranches?.branches ?? [],
        worktrees,
        query,
        selected: branch || projectBranches?.current || null,
        workCwd: cwd,
        allowWorktrees,
      }),
    [allowWorktrees, branch, cwd, projectBranches, query, worktrees],
  );

  useEffect(() => {
    setActive((i) => (rows.length === 0 ? 0 : Math.min(i, rows.length - 1)));
  }, [rows.length]);

  const applySwitch = (pending: PendingSwitch) =>
    pending.kind === "create"
      ? gitCreateBranch(cwd, pending.name)
      : gitCheckout(cwd, pending.name, pending.remote);

  const finishSwitch = (name: string) => {
    notifyGitChanged();
    onChangeRef.current?.(name);
    dismiss(true);
  };

  const failMessage = (err: unknown) =>
    err instanceof Error ? err.message : String(err);

  const run = async (pending: PendingSwitch) => {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await applySwitch(pending);
      finishSwitch(pending.name);
    } catch (err) {
      const message = failMessage(err);
      if (isCheckoutBlockedByChanges(message)) {
        setOpen(false);
        setQuery("");
        setError(null);
        setBusy(false);
        setBlockedError(null);
        setBlockedBusy(null);
        setBlocked(pending);
        return;
      }
      setError(message);
      setBusy(false);
      search.current?.focus();
    }
  };

  // Creating a worktree never touches this checkout, so a failure is reported
  // in the menu instead of offering to stash or commit.
  const runWorktree = async (name: string, exists: boolean) => {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const target = await gitWorktreeAdd(cwd, {
        name,
        create: !exists,
        root: loadWorktreeRoot(),
      });
      notifyGitChanged();
      onWorktreeRef.current?.(target);
      dismiss(true);
    } catch (err) {
      setError(failMessage(err));
      setBusy(false);
      search.current?.focus();
    }
  };

  const resolveBlocked = async (
    kind: "stash" | "commit",
    work: () => Promise<unknown>,
  ) => {
    if (!blocked || blockedBusy) return;
    setBlockedBusy(kind);
    setBlockedError(null);
    try {
      await work();
      await applySwitch(blocked);
      finishSwitch(blocked.name);
    } catch (err) {
      setBlockedError(failMessage(err));
      setBlockedBusy(null);
    }
  };

  const pick = (row: BranchRow) => {
    if (row.kind === "create") {
      void run({ kind: "create", name: row.name });
      return;
    }
    if (row.kind === "create-worktree") {
      void runWorktree(row.name, row.exists);
      return;
    }
    if (row.kind === "worktree") {
      onWorktreeRef.current?.({
        path: row.worktree.path,
        branch: row.worktree.branch ?? row.worktree.head,
      });
      dismiss(true);
      return;
    }
    if (row.branch.current) {
      dismiss(true);
      return;
    }
    void run({
      kind: "checkout",
      name: row.branch.name,
      remote: row.branch.remote,
    });
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rows.length === 0) return;
      setActive((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    }
  };

  // Always keep the control mounted so the composer's toolbar does not resize
  // when a folder isn't a git repo. The loading skeleton, "No repo" label, and
  // real branch all share the same icon + 12px mono line box.
  const awaitingBranch = inProject && !current && !branchesSettled;
  const missingGit = !current && !awaitingBranch;
  const label = current
    ? detached
      ? `detached ${current}`
      : current
    : "No repo";
  const worktreeLabel = worktreePath ? prettyCwd(worktreePath) : null;
  const title = awaitingBranch
    ? "Loading branch…"
    : missingGit
      ? "No git repository"
      : worktreeLabel
        ? `${label} · worktree ${worktreeLabel}`
        : label;
  const interactive = enabled && !awaitingBranch && !missingGit;

  return (
    <div className="flex max-w-[45%] shrink-0 items-center gap-2.5">
      <div ref={root} className="relative min-w-0">
        <button
          type="button"
          title={title}
          aria-label={
            awaitingBranch
              ? "Loading branch"
              : missingGit
                ? "No git repository"
                : worktreeLabel
                  ? `Branch ${label} in worktree ${worktreeLabel}`
                  : `Branch ${label}`
          }
          aria-expanded={missingGit ? undefined : open}
          aria-haspopup={missingGit ? undefined : "dialog"}
          disabled={!interactive}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!interactive || blocked) return;
            if (open) {
              dismiss(true);
              return;
            }
            setOpen(true);
          }}
          className={
            missingGit
              ? "flex min-w-0 cursor-default items-center gap-1.5 text-content/50"
              : `flex min-w-0 items-center gap-1.5 ${
                  open ? "text-content" : "text-content/50 hover:text-content"
                } disabled:opacity-40 disabled:hover:text-content/50`
          }
        >
          <GitBranch className="size-3.5 shrink-0" strokeWidth={1.5} />
          <span className="relative truncate font-mono text-[12px]">
            {awaitingBranch ? (
              <>
                {/*
                  A real text node, hidden rather than absent, so the pending
                  line box is produced exactly the way the loaded one is — the
                  toolbar's height cannot depend on which branch we are in.
                  "main" also keeps the reserved width near a typical branch.
                */}
                <span className="invisible">main</span>
                <span className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-current opacity-50" />
              </>
            ) : (
              label
            )}
          </span>
        </button>
        {blocked ? (
          <SwitchBranchDialog
            cwd={cwd}
            branch={blocked.name}
            creating={blocked.kind === "create"}
            busy={blockedBusy}
            error={blockedError}
            onStash={() => {
              void resolveBlocked("stash", () =>
                gitStash(cwd, `WIP before switching to ${blocked.name}`),
              );
            }}
            onCommit={(message) => {
              void resolveBlocked("commit", async () => {
                await gitStageAll(cwd);
                await gitCommit(cwd, message);
              });
            }}
            onCancel={() => {
              if (blockedBusy) return;
              setBlocked(null);
              setBlockedError(null);
              onCloseRef.current?.();
            }}
          />
        ) : null}
        {open ? (
          <Popover
            anchor={root}
            side="top"
            width={MENU_WIDTH}
            minHeight={MENU_MIN_HEIGHT}
            maxHeight={MENU_MAX_HEIGHT}
            onDismiss={(reason) => dismiss(reason === "escape")}
            role="dialog"
            aria-label="Branch picker"
            data-branch-picker
            className="flex flex-col overflow-hidden"
          >
            <label className="flex shrink-0 items-center gap-2 border-b border-content/10 px-2 py-2.5 text-content/50">
              <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
              <input
                ref={search}
                type="text"
                value={query}
                placeholder="Search or create a branch..."
                aria-label="Search or create a branch"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                disabled={busy}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/40 disabled:opacity-60"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                  setError(null);
                }}
                onKeyDown={onSearchKey}
              />
            </label>
            <BranchList
              rows={rows}
              active={active}
              busy={busy}
              emptyLabel={query.trim() ? "No matching branches" : "No branches"}
              onActive={setActive}
              onPick={pick}
            />
            {error ? (
              <p className="max-h-16 shrink-0 overflow-y-auto whitespace-pre-wrap border-t border-content/10 px-2.5 py-2 text-[11px] leading-4 text-red-400/90">
                {error}
              </p>
            ) : null}
          </Popover>
        ) : null}
      </div>
    </div>
  );
}

function BranchList({
  rows,
  active,
  busy,
  emptyLabel,
  onActive,
  onPick,
}: {
  rows: BranchRow[];
  active: number;
  busy: boolean;
  emptyLabel: string;
  onActive: (index: number) => void;
  onPick: (row: BranchRow) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (rows.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] text-content/50">{emptyLabel}</div>
    );
  }

  return (
    <div
      ref={lockOverscroll}
      role="listbox"
      aria-label="Branches"
      className="min-h-0 flex-1 overflow-y-auto overscroll-none px-1.5 py-1.5"
    >
      {rows.map((row, index) => {
        const highlighted = index === active;
        const selected = row.kind === "branch" && row.branch.current;
        const create =
          row.kind === "create" || row.kind === "create-worktree";
        return (
          <button
            key={
              row.kind === "create"
                ? `create:${row.name}`
                : row.kind === "create-worktree"
                  ? `create-worktree:${row.name}`
                  : row.kind === "worktree"
                    ? `worktree:${row.worktree.path}`
                    : `${row.branch.remote ?? "local"}:${row.branch.name}`
            }
            ref={highlighted ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={selected}
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onActive(index)}
            onClick={() => onPick(row)}
            className={
              create
                ? `mb-1 flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left disabled:opacity-60 ${
                    highlighted
                      ? "bg-content/15 text-content"
                      : "bg-content/10 text-content hover:bg-content/15"
                  }`
                : `flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left disabled:opacity-60 ${
                    highlighted || selected
                      ? "bg-content/10 text-content"
                      : "text-content hover:bg-content/5"
                  }`
            }
          >
            {row.kind === "create" ? (
              <>
                <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 truncate text-[12px]">
                  Create and checkout {row.name}
                </span>
              </>
            ) : row.kind === "create-worktree" ? (
              <>
                <FolderPlus className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 truncate text-[12px]">
                  {row.exists ? "Open" : "Create"} {row.name} in a new worktree
                </span>
              </>
            ) : row.kind === "worktree" ? (
              <>
                <Folder
                  className="size-3.5 shrink-0 text-content/50"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                  {row.worktree.branch ?? row.worktree.head}
                </span>
                <span className="max-w-[45%] shrink-0 truncate text-[10px] text-content/40">
                  {prettyCwd(row.worktree.path)}
                </span>
              </>
            ) : (
              <>
                {selected ? (
                  <Check className="size-3.5 shrink-0" strokeWidth={1.75} />
                ) : (
                  <GitBranch
                    className="size-3.5 shrink-0 text-content/50"
                    strokeWidth={1.75}
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                  {row.branch.name}
                </span>
                {row.branch.remote ? (
                  <span className="shrink-0 text-[10px] text-content/40">
                    {row.branch.remote}
                  </span>
                ) : null}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
