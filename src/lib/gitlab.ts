import { invoke } from "@tauri-apps/api/core";
import type {
  GithubPrDiff,
  GithubTaskKind,
  GithubWorkItem,
  GithubWorkItemDetails,
  GithubWorkItemQuery,
  GithubWorkItemThread,
} from "./githubTasks";

export type GitlabStatus = {
  installed: boolean;
  version: string;
};

export function gitlabStatus(): Promise<GitlabStatus> {
  return invoke<GitlabStatus>("gitlab_status");
}

export function gitlabRepo(cwd: string): Promise<string> {
  return invoke<string>("gitlab_repo", { cwd });
}

export function listGitlabWorkItems(
  cwd: string,
  query: GithubWorkItemQuery & { limit?: number },
): Promise<GithubWorkItem[]> {
  return invoke<GithubWorkItem[]>("gitlab_work_items", {
    cwd,
    kind: query.kind,
    assignedToMe: query.assignedToMe,
    state: query.state,
    search: query.search.trim(),
    limit: query.limit,
  });
}

export function gitlabWorkItemDetails(
  cwd: string,
  kind: GithubTaskKind,
  number: number,
): Promise<GithubWorkItemDetails> {
  return invoke<GithubWorkItemDetails>("gitlab_work_item_details", {
    cwd,
    kind,
    number,
  });
}

export function gitlabWorkItemThread(
  cwd: string,
  kind: GithubTaskKind,
  number: number,
): Promise<GithubWorkItemThread> {
  return invoke<GithubWorkItemThread>("gitlab_work_item_thread", {
    cwd,
    kind,
    number,
  });
}

/** `inReplyTo` is a discussion id; empty starts a new discussion. */
export function gitlabWorkItemComment(
  cwd: string,
  kind: GithubTaskKind,
  number: number,
  body: string,
  inReplyTo: string,
): Promise<string> {
  return invoke<string>("gitlab_work_item_comment", {
    cwd,
    kind,
    number,
    body: body.trim(),
    inReplyTo: inReplyTo.trim(),
  });
}

export function gitlabMrDiff(cwd: string, number: number): Promise<GithubPrDiff> {
  return invoke<GithubPrDiff>("gitlab_mr_diff", { cwd, number });
}
