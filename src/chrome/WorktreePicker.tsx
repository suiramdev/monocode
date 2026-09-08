import { Check, Folder, FolderPlus, Loader, Search } from "./icons";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  basename,
  gitWorktreeAdd,
  gitWorktrees,
  notifyGitChanged,
  type GitWorktreeAdd,
  type GitWorktreeInfo,
} from "../lib/fs";
import {
  runWorktreeScript,
  worktreeScriptFailure,
} from "../lib/worktreeScripts";
import {
  buildWorktreeRows,
  suggestWorktreeName,
  type WorktreeRow,
} from "../lib/worktreeRows";
import { prettyCwd } from "../lib/paths";
import { loadWorktreeRoot } from "../lib/settings";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useProjectBranchesState } from "../hooks/useProjectBranches";
import { Popover } from "./Popover";

type Props = {
  /** Working copy the session runs in; where git commands run. */
  cwd: string;
  /** The session's project checkout, offered as the row with no worktree. */
  projectCwd: string;
  branch?: string;
  worktreePath?: string;
  enabled?: boolean;
  /** A worktree to run in, or null for the project checkout. */
  onChange: (target: { path: string; branch: string } | null) => void;
  onClose?: () => void;
};

const MENU_WIDTH = 280;
const MENU_MIN_HEIGHT = 180;
const MENU_MAX_HEIGHT = 280;

export function WorktreePicker({
  cwd,
  projectCwd,
  branch,
  worktreePath,
  enabled = true,
  onChange,
  onClose,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const inProject = Boolean(cwd) && cwd !== "~";
  const { branches: projectBranches } = useProjectBranchesState(cwd, inProject);
  const selected = branch || projectBranches?.current || null;

  const dismiss = (restore: boolean) => {
    setOpen(false);
    setQuery("");
    setError(null);
    setStatus(null);
    setBusy(false);
    if (restore) onCloseRef.current?.();
  };

  const reload = useCallback(async () => {
    const list = await gitWorktrees(cwd).catch(() => []);
    setWorktrees(list);
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setActive(0);
    search.current?.focus();
  }, [open]);

  useEffect(() => {
    if (enabled) return;
    setOpen(false);
    setQuery("");
    setError(null);
    setStatus(null);
    setBusy(false);
  }, [enabled]);

  // `git worktree list` shells out, so read it when the menu opens rather than
  // on every branch refresh.
  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open, reload]);

  const rows = useMemo(
    () =>
      buildWorktreeRows({
        worktrees,
        branches: projectBranches?.branches ?? [],
        projectCwd,
        currentPath: worktreePath ?? null,
        branch: selected,
        suggested: suggestWorktreeName(
          selected,
          projectBranches?.branches ?? [],
        ),
        query,
      }),
    [projectBranches, projectCwd, query, selected, worktrees, worktreePath],
  );

  useEffect(() => {
    setActive((i) => (rows.length === 0 ? 0 : Math.min(i, rows.length - 1)));
  }, [rows.length]);

  const create = async (name: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    let target: GitWorktreeAdd;
    try {
      target = await gitWorktreeAdd(cwd, {
        name,
        base: selected,
        root: loadWorktreeRoot(),
      });
      notifyGitChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      search.current?.focus();
      return;
    }
    // The worktree is on disk from here on: a setup script that fails is
    // reported against a worktree the menu now lists, ready to open anyway.
    if (target.created) {
      setStatus(`Running the setup script in ${basename(target.path)}…`);
      try {
        const run = await runWorktreeScript("setup", {
          project: projectCwd,
          worktree: target.path,
          branch: target.branch,
        });
        if (run && run.code !== 0) {
          setError(worktreeScriptFailure("setup", run));
          setStatus(null);
          setBusy(false);
          void reload();
          search.current?.focus();
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus(null);
        setBusy(false);
        void reload();
        search.current?.focus();
        return;
      }
    }
    onChangeRef.current(target);
    dismiss(true);
  };

  const pick = (row: WorktreeRow) => {
    if (row.kind === "create") {
      void create(row.name);
      return;
    }
    if (row.current) {
      dismiss(true);
      return;
    }
    onChangeRef.current(
      row.kind === "project"
        ? null
        : {
            path: row.worktree.path,
            branch: row.worktree.branch ?? row.worktree.head,
          },
    );
    dismiss(true);
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

  // Without a repository there is nothing to cut a worktree from, and the
  // branch picker already carries the "No repo" line for the toolbar.
  if (!worktreePath && !projectBranches?.current) return null;

  const label = worktreePath ? basename(worktreePath) : "Project";
  const title = worktreePath
    ? `Worktree ${label} · ${prettyCwd(worktreePath)}`
    : `Project checkout · ${prettyCwd(projectCwd)}`;

  return (
    <div ref={root} className="relative min-w-0 shrink">
      <button
        type="button"
        title={title}
        aria-label={
          worktreePath ? `Worktree ${label}` : "Running in the project checkout"
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={!enabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!enabled) return;
          if (open) {
            dismiss(true);
            return;
          }
          setOpen(true);
        }}
        className={`flex min-w-0 items-center gap-1.5 ${
          open ? "text-content" : "text-content/50 hover:text-content"
        } disabled:opacity-40 disabled:hover:text-content/50`}
      >
        <Folder className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="truncate font-mono text-[12px]">{label}</span>
      </button>
      {open ? (
        <Popover
          anchor={root}
          side="top"
          width={MENU_WIDTH}
          minHeight={MENU_MIN_HEIGHT}
          maxHeight={MENU_MAX_HEIGHT}
          onDismiss={(reason) => dismiss(reason === "escape")}
          role="dialog"
          aria-label="Worktree picker"
          data-worktree-picker
          className="flex flex-col overflow-hidden"
        >
          <label className="flex shrink-0 items-center gap-2 border-b border-content/10 px-2 py-2.5 text-content/50">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              ref={search}
              type="text"
              value={query}
              placeholder="Search or name a worktree..."
              aria-label="Search or name a worktree"
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
          <WorktreeList
            rows={rows}
            active={active}
            busy={busy}
            branch={selected}
            emptyLabel={
              query.trim() ? "No matching worktrees" : "No worktrees"
            }
            onActive={setActive}
            onPick={pick}
          />
          {status ? (
            <p className="flex shrink-0 items-center gap-2 border-t border-content/10 px-2.5 py-2 text-[11px] leading-4 text-content/60">
              <Loader
                className="size-3 shrink-0 animate-spin"
                strokeWidth={1.75}
                aria-hidden
              />
              <span className="min-w-0 truncate">{status}</span>
            </p>
          ) : null}
          {error ? (
            <p className="max-h-16 shrink-0 overflow-y-auto whitespace-pre-wrap border-t border-content/10 px-2.5 py-2 text-[11px] leading-4 text-red-400/90">
              {error}
            </p>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}

/** Header above the first row of each group, so a group is named once. */
function groupHeader(
  row: WorktreeRow,
  previous: WorktreeRow | undefined,
  branch: string | null,
): string | null {
  if (row.kind !== "worktree") return null;
  if (previous?.kind === "worktree" && previous.related === row.related) {
    return null;
  }
  if (!row.related) return branch ? "Other worktrees" : "Worktrees";
  return `For ${branch}`;
}

function WorktreeList({
  rows,
  active,
  busy,
  branch,
  emptyLabel,
  onActive,
  onPick,
}: {
  rows: WorktreeRow[];
  active: number;
  busy: boolean;
  branch: string | null;
  emptyLabel: string;
  onActive: (index: number) => void;
  onPick: (row: WorktreeRow) => void;
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
      aria-label="Worktrees"
      className="min-h-0 flex-1 overflow-y-auto overscroll-none px-1.5 py-1.5"
    >
      {rows.map((row, index) => {
        const highlighted = index === active;
        const selected = row.kind !== "create" && row.current;
        const header = groupHeader(row, rows[index - 1], branch);
        const path = row.kind === "project" ? row.path : null;
        const worktree = row.kind === "worktree" ? row.worktree : null;
        const holds = worktree ? (worktree.branch ?? worktree.head) : null;
        const name = worktree ? basename(worktree.path) : "Project";
        // The branch earns the trailing slot only when it is not the name
        // already on the row; the full path is in the tooltip either way.
        const hint = path ? prettyCwd(path) : holds === name ? null : holds;
        return (
          <Fragment
            key={
              row.kind === "create"
                ? `create:${row.name}`
                : row.kind === "project"
                  ? "project"
                  : `worktree:${row.worktree.path}`
            }
          >
            {header ? (
              <div
                role="presentation"
                className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-content/40 uppercase"
              >
                {header}
              </div>
            ) : null}
            <button
              ref={highlighted ? activeRef : undefined}
              type="button"
              role="option"
              title={
                worktree
                  ? `${prettyCwd(worktree.path)} · ${holds}`
                  : (path ?? undefined)
              }
              aria-selected={selected}
              disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onActive(index)}
              onClick={() => onPick(row)}
              className={
                row.kind === "create"
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
                  <FolderPlus className="size-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0 truncate text-[12px]">
                    {row.exists ? "Open" : "New worktree"}{" "}
                    <span className="font-mono">{row.name}</span>
                    {row.exists ? " in a worktree" : null}
                  </span>
                </>
              ) : (
                <>
                  {selected ? (
                    <Check className="size-3.5 shrink-0" strokeWidth={1.75} />
                  ) : (
                    <Folder
                      className="size-3.5 shrink-0 text-content/50"
                      strokeWidth={1.75}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                    {name}
                  </span>
                  {hint ? (
                    <span className="max-w-[55%] shrink-0 truncate text-[10px] text-content/40">
                      {hint}
                    </span>
                  ) : null}
                </>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
