use std::fmt::Write as _;
use std::io::ErrorKind;
use std::path::Path;
use std::process::Command;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::fs::{
    GitHubAssignee, GitHubLabel, GitHubPrDiff, GitHubPrFile, GitHubWorkItem, GitHubWorkItemComment,
    GitHubWorkItemDetails, GitHubWorkItemThread, GitPr, GitPrCreateInput,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabStatus {
    pub installed: bool,
    pub version: String,
}

/// Whether `glab` is reachable from the GUI path, and which version answered.
#[tauri::command]
pub async fn gitlab_status() -> Result<GitlabStatus, String> {
    tauri::async_runtime::spawn_blocking(gitlab_status_for)
        .await
        .map_err(|e| e.to_string())?
}

/// `group/project` for the GitLab remote of this working copy, via `glab`.
#[tauri::command]
pub async fn gitlab_repo(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || gitlab_repo_for(&crate::fs::expand_home(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}

/// Issues or merge requests for the current GitLab remote, via `glab api`.
#[tauri::command]
pub async fn gitlab_work_items(
    cwd: String,
    kind: String,
    assigned_to_me: bool,
    state: String,
    search: String,
    limit: Option<u32>,
) -> Result<Vec<GitHubWorkItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gitlab_work_items_for(
            &crate::fs::expand_home(&cwd),
            &kind,
            assigned_to_me,
            &state,
            &search,
            limit.unwrap_or(40),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Issue or merge request body for the inbox detail pane.
#[tauri::command]
pub async fn gitlab_work_item_details(
    cwd: String,
    kind: String,
    number: i64,
) -> Result<GitHubWorkItemDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gitlab_item_details_for(&crate::fs::expand_home(&cwd), &kind, number)
            .map(|(details, _)| details)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Conversation for the inbox detail pane: discussions, flattened to threads.
#[tauri::command]
pub async fn gitlab_work_item_thread(
    cwd: String,
    kind: String,
    number: i64,
) -> Result<GitHubWorkItemThread, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gitlab_work_item_thread_for(&crate::fs::expand_home(&cwd), &kind, number)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Post a note, or a reply inside an existing discussion.
#[tauri::command]
pub async fn gitlab_work_item_comment(
    cwd: String,
    kind: String,
    number: i64,
    body: String,
    in_reply_to: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gitlab_work_item_comment_for(
            &crate::fs::expand_home(&cwd),
            &kind,
            number,
            &body,
            &in_reply_to,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Unified diff and file stats for a merge request, via `glab api`.
#[tauri::command]
pub async fn gitlab_mr_diff(cwd: String, number: i64) -> Result<GitHubPrDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gitlab_mr_diff_for(&crate::fs::expand_home(&cwd), number)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn gitlab_status_for() -> Result<GitlabStatus, String> {
    if crate::harness::resolve_gui_binary("glab").is_none() {
        return Ok(GitlabStatus {
            installed: false,
            version: String::new(),
        });
    }
    let output = glab_run(&crate::fs::expand_home("~"), &["--version"], true).unwrap_or_default();
    Ok(GitlabStatus {
        installed: true,
        version: output.lines().next().unwrap_or_default().trim().to_string(),
    })
}

fn gitlab_repo_for(root: &Path) -> Result<String, String> {
    #[derive(Deserialize)]
    struct GitlabProject {
        #[serde(default)]
        path_with_namespace: String,
    }
    let json = api_get(root, "projects/:id", false)?;
    let project: GitlabProject = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let slug = project.path_with_namespace.trim();
    if slug.is_empty() {
        return Err("GitLab did not return a project".into());
    }
    Ok(slug.to_string())
}

fn gitlab_work_items_for(
    root: &Path,
    kind: &str,
    assigned_to_me: bool,
    state: &str,
    search: &str,
    limit: u32,
) -> Result<Vec<GitHubWorkItem>, String> {
    let kind = kind.trim();
    let endpoint = work_items_endpoint(kind, assigned_to_me, state, search, limit)?;
    let json = api_get(root, &endpoint, false)?;
    parse_gitlab_work_items(&json, kind)
}

/// The detail call doubles as the `web_url` lookup that note links need.
fn gitlab_item_details_for(
    root: &Path,
    kind: &str,
    number: i64,
) -> Result<(GitHubWorkItemDetails, String), String> {
    #[derive(Deserialize)]
    struct GitlabItemRow {
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        author: Option<GitlabUser>,
        #[serde(default)]
        web_url: String,
        #[serde(default)]
        target_branch: String,
        #[serde(default)]
        source_branch: String,
    }
    let endpoint = item_endpoint(kind, number)?;
    let json = api_get(root, &endpoint, false)?;
    let row: GitlabItemRow = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let merge_request = kind.trim() == "pr";
    let details = GitHubWorkItemDetails {
        body: row.description.unwrap_or_default(),
        author: row.author.map(|author| author.username).unwrap_or_default(),
        author_avatar_url: String::new(),
        base_ref_name: if merge_request {
            row.target_branch
        } else {
            String::new()
        },
        head_ref_name: if merge_request {
            row.source_branch
        } else {
            String::new()
        },
        review_decision: if merge_request {
            approvals_query(root, number)
        } else {
            String::new()
        },
    };
    Ok((details, row.web_url))
}

fn gitlab_work_item_thread_for(
    root: &Path,
    kind: &str,
    number: i64,
) -> Result<GitHubWorkItemThread, String> {
    let (details, web_url) = gitlab_item_details_for(root, kind, number)?;
    let endpoint = format!("{}/discussions?per_page=100", item_endpoint(kind, number)?);
    let json = api_get(root, &endpoint, true)?;
    Ok(GitHubWorkItemThread {
        comments: parse_gitlab_discussions(&json, &web_url)?,
        truncated: false,
        review_decision: details.review_decision,
        base_ref_name: details.base_ref_name,
        head_ref_name: details.head_ref_name,
    })
}

fn gitlab_work_item_comment_for(
    root: &Path,
    kind: &str,
    number: i64,
    body: &str,
    in_reply_to: &str,
) -> Result<String, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("Comment cannot be empty".into());
    }
    let item = item_endpoint(kind, number)?;
    let in_reply_to = in_reply_to.trim();
    let endpoint = if in_reply_to.is_empty() {
        format!("{item}/notes")
    } else if valid_discussion_id(in_reply_to) {
        format!("{item}/discussions/{in_reply_to}/notes")
    } else {
        return Err("Invalid discussion".into());
    };
    let json = crate::fs::with_temp_markdown(body, |path| {
        api_post(root, &endpoint, &[], &[("body", path)])
    })?;
    #[derive(Deserialize)]
    struct Created {
        #[serde(default)]
        id: i64,
    }
    let created: Created = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let web_url = gitlab_item_details_for(root, kind, number)
        .map(|(_, url)| url)
        .unwrap_or_default();
    if web_url.trim().is_empty() {
        return Ok(format!("note_{}", created.id));
    }
    Ok(format!("{web_url}#note_{}", created.id))
}

fn gitlab_mr_diff_for(root: &Path, number: i64) -> Result<GitHubPrDiff, String> {
    if number <= 0 {
        return Err("Invalid GitLab item number".into());
    }
    let endpoint = format!("projects/:id/merge_requests/{number}/diffs?per_page=100");
    let json = api_get(root, &endpoint, true)?;
    parse_gitlab_diffs(&json)
}

/// Latest merge request whose source branch is `branch`, if `glab` can see one.
pub(crate) fn mr_status_for(root: &Path, branch: &str) -> Option<GitPr> {
    let endpoint = format!(
        "projects/:id/merge_requests?source_branch={}&state=all&per_page=20&order_by=updated_at&sort=desc",
        percent_encode(branch)
    );
    let json = api_get(root, &endpoint, false).ok()?;
    parse_gitlab_mr_status(&json)
}

/// Create a GitLab merge request with `glab api` and return its URL.
pub(crate) fn mr_create_for(root: &Path, input: &GitPrCreateInput) -> Result<String, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Merge request title cannot be empty".into());
    }
    let json = crate::fs::with_temp_markdown(input.body.trim(), |path| {
        api_post(
            root,
            "projects/:id/merge_requests",
            &[
                ("source_branch", input.head.trim()),
                ("target_branch", input.base.trim()),
                ("title", title),
            ],
            &[("description", path)],
        )
    })?;
    #[derive(Deserialize)]
    struct Created {
        #[serde(default)]
        web_url: String,
    }
    let created: Created = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let url = created.web_url.trim();
    if url.is_empty() {
        return Err("glab returned no merge request URL".into());
    }
    Ok(url.to_string())
}

fn approvals_query(root: &Path, number: i64) -> String {
    #[derive(Deserialize)]
    struct Approvals {
        #[serde(default)]
        approved_by: Vec<serde_json::Value>,
        #[serde(default)]
        approvals_required: i64,
    }
    let endpoint = format!("projects/:id/merge_requests/{number}/approvals");
    let Ok(json) = api_get(root, &endpoint, false) else {
        return String::new();
    };
    let Ok(approvals) = serde_json::from_str::<Approvals>(&json) else {
        return String::new();
    };
    if !approvals.approved_by.is_empty() {
        return "APPROVED".into();
    }
    if approvals.approvals_required > 0 {
        return "REVIEW_REQUIRED".into();
    }
    String::new()
}

#[derive(Deserialize)]
struct GitlabUser {
    #[serde(default)]
    username: String,
}

#[derive(Deserialize)]
struct GitlabLabelRow {
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
}

#[derive(Deserialize)]
struct GitlabReferences {
    #[serde(default)]
    full: String,
}

#[derive(Deserialize)]
struct GitlabWorkItemRow {
    #[serde(default)]
    iid: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    web_url: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    labels: Vec<GitlabLabelRow>,
    #[serde(default)]
    assignees: Vec<GitlabUser>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    references: Option<GitlabReferences>,
}

fn parse_gitlab_work_items(json: &str, kind: &str) -> Result<Vec<GitHubWorkItem>, String> {
    let rows: Vec<GitlabWorkItemRow> = parse_json_pages(json)?;
    Ok(rows
        .into_iter()
        .map(|row| GitHubWorkItem {
            kind: kind.to_string(),
            number: row.iid,
            title: row.title,
            url: row.web_url,
            state: gitlab_state(&row.state).to_string(),
            updated_at: row.updated_at,
            labels: row
                .labels
                .into_iter()
                .map(|label| GitHubLabel {
                    name: label.name,
                    color: label.color,
                })
                .collect(),
            assignees: row
                .assignees
                .into_iter()
                .map(|user| GitHubAssignee {
                    login: user.username,
                    avatar_url: String::new(),
                })
                .collect(),
            draft: kind == "pr" && row.draft,
            repo: repo_slug(
                &row.references.map(|refs| refs.full).unwrap_or_default(),
                kind,
            ),
        })
        .collect())
}

fn parse_gitlab_mr_status(json: &str) -> Option<GitPr> {
    let rows: Vec<GitlabWorkItemRow> = parse_json_pages(json).ok()?;
    let mut fallback: Option<GitPr> = None;
    for row in rows {
        let state = gitlab_state(&row.state);
        let pr = GitPr {
            number: row.iid,
            title: row.title,
            url: row.web_url,
            state: state.to_string(),
        };
        if state == "open" {
            return Some(pr);
        }
        if fallback.is_none() {
            fallback = Some(pr);
        }
    }
    fallback
}

#[derive(Deserialize)]
struct GitlabPosition {
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    new_path: Option<String>,
    #[serde(default)]
    old_line: Option<i64>,
    #[serde(default)]
    new_line: Option<i64>,
}

#[derive(Deserialize)]
struct GitlabNote {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    resolved: Option<bool>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    author: Option<GitlabUser>,
    #[serde(default)]
    position: Option<GitlabPosition>,
}

#[derive(Deserialize)]
struct GitlabDiscussion {
    #[serde(default)]
    id: String,
    #[serde(default)]
    notes: Vec<GitlabNote>,
}

fn parse_gitlab_discussions(
    json: &str,
    web_url: &str,
) -> Result<Vec<GitHubWorkItemComment>, String> {
    let discussions: Vec<GitlabDiscussion> = parse_json_pages(json)?;
    let mut out = Vec::with_capacity(discussions.len());
    for discussion in discussions {
        let mut notes = discussion.notes.into_iter().filter(|note| !note.system);
        let Some(first) = notes.next() else {
            continue;
        };
        let mut comment = gitlab_comment(first, &discussion.id, web_url, true);
        comment.replies = notes
            .map(|note| gitlab_comment(note, &discussion.id, web_url, false))
            .collect();
        out.push(comment);
    }
    Ok(out)
}

fn gitlab_comment(
    note: GitlabNote,
    thread_id: &str,
    web_url: &str,
    root: bool,
) -> GitHubWorkItemComment {
    let position = note.position;
    let path = position
        .as_ref()
        .and_then(|at| at.new_path.clone().or_else(|| at.old_path.clone()))
        .unwrap_or_default();
    let line = position.as_ref().and_then(|at| at.new_line.or(at.old_line));
    GitHubWorkItemComment {
        id: note.id.to_string(),
        kind: if root && position.is_some() {
            "review_comment".into()
        } else {
            "comment".into()
        },
        author: note
            .author
            .map(|author| author.username)
            .unwrap_or_default(),
        author_avatar_url: String::new(),
        body: note.body.unwrap_or_default(),
        created_at: note.created_at,
        url: format!("{web_url}#note_{}", note.id),
        state: String::new(),
        path,
        line,
        resolved: note.resolved.unwrap_or(false),
        thread_id: thread_id.to_string(),
        replies: Vec::new(),
    }
}

#[derive(Deserialize)]
struct GitlabDiffRow {
    #[serde(default)]
    old_path: String,
    #[serde(default)]
    new_path: String,
    #[serde(default)]
    new_file: bool,
    #[serde(default)]
    deleted_file: bool,
    #[serde(default)]
    diff: String,
}

fn parse_gitlab_diffs(json: &str) -> Result<GitHubPrDiff, String> {
    let rows: Vec<GitlabDiffRow> = parse_json_pages(json)?;
    let mut diff = GitHubPrDiff {
        additions: 0,
        deletions: 0,
        files: Vec::with_capacity(rows.len()),
        patch: String::new(),
        truncated: false,
    };
    for row in rows {
        let (additions, deletions) = count_diff_lines(&row.diff);
        diff.additions += additions;
        diff.deletions += deletions;
        diff.files.push(GitHubPrFile {
            path: row.new_path.clone(),
            additions,
            deletions,
        });
        if diff.truncated {
            continue;
        }
        let chunk = diff_chunk(&row);
        if diff.patch.len() + chunk.len() > crate::fs::MAX_PR_DIFF_BYTES {
            diff.truncated = true;
            continue;
        }
        diff.patch.push_str(&chunk);
    }
    Ok(diff)
}

fn count_diff_lines(diff: &str) -> (i64, i64) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in diff.lines() {
        if line.starts_with("+++ ") || line.starts_with("--- ") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

/// GitLab hands back only the hunks, so the `git`-style header that
/// `parsePrDiff` splits on has to be rebuilt per file.
fn diff_chunk(row: &GitlabDiffRow) -> String {
    let old = if row.new_file {
        "/dev/null".to_string()
    } else {
        format!("a/{}", row.old_path)
    };
    let new = if row.deleted_file {
        "/dev/null".to_string()
    } else {
        format!("b/{}", row.new_path)
    };
    let mut chunk = format!(
        "diff --git a/{} b/{}\n--- {old}\n+++ {new}\n{}",
        row.old_path, row.new_path, row.diff
    );
    if !chunk.ends_with('\n') {
        chunk.push('\n');
    }
    chunk
}

fn repo_slug(full: &str, kind: &str) -> String {
    let separator = if kind == "pr" { '!' } else { '#' };
    match full.rfind(separator) {
        Some(at) => full[..at].to_string(),
        None => String::new(),
    }
}

fn gitlab_state(state: &str) -> &'static str {
    match state.trim() {
        "closed" => "closed",
        "merged" => "merged",
        _ => "open",
    }
}

fn work_items_endpoint(
    kind: &str,
    assigned_to_me: bool,
    state: &str,
    search: &str,
    limit: u32,
) -> Result<String, String> {
    let path = match kind.trim() {
        "issue" => "issues",
        "pr" => "merge_requests",
        _ => return Err("Unknown GitLab task kind".into()),
    };
    let state = if state.trim().eq_ignore_ascii_case("all") {
        "all"
    } else {
        "opened"
    };
    let scope = if assigned_to_me {
        "assigned_to_me"
    } else {
        "all"
    };
    let per_page = limit.clamp(1, 100);
    let mut endpoint = format!(
        "projects/:id/{path}?state={state}&scope={scope}&per_page={per_page}&order_by=updated_at&sort=desc&with_labels_details=true"
    );
    let search = search.trim();
    if !search.is_empty() {
        let _ = write!(endpoint, "&search={}", percent_encode(search));
    }
    Ok(endpoint)
}

fn item_endpoint(kind: &str, iid: i64) -> Result<String, String> {
    let path = match kind.trim() {
        "issue" => "issues",
        "pr" => "merge_requests",
        _ => return Err("Unknown GitLab task kind".into()),
    };
    if iid <= 0 {
        return Err("Invalid GitLab item number".into());
    }
    Ok(format!("projects/:id/{path}/{iid}"))
}

fn valid_discussion_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty() && id.len() <= 64 && id.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

fn api_get(root: &Path, endpoint: &str, paginate: bool) -> Result<String, String> {
    if paginate {
        glab_checked(root, &["api", endpoint, "--paginate"])
    } else {
        glab_checked(root, &["api", endpoint])
    }
}

fn api_post(
    root: &Path,
    endpoint: &str,
    fields: &[(&str, &str)],
    files: &[(&str, &str)],
) -> Result<String, String> {
    let mut args = vec![
        "api".to_string(),
        "--method".to_string(),
        "POST".to_string(),
        endpoint.to_string(),
    ];
    for (key, value) in fields {
        args.push("-f".to_string());
        args.push(format!("{key}={value}"));
    }
    for (key, path) in files {
        args.push("-F".to_string());
        args.push(format!("{key}=@{path}"));
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    glab_checked(root, &refs)
}

/// `glab api --paginate` prints one JSON array per page, so a response is a
/// stream of documents rather than a single array.
fn parse_json_pages<T: DeserializeOwned>(json: &str) -> Result<Vec<T>, String> {
    let mut rows = Vec::new();
    for page in serde_json::Deserializer::from_str(json).into_iter::<Vec<T>>() {
        rows.extend(page.map_err(|error| error.to_string())?);
    }
    Ok(rows)
}

pub(crate) fn glab_stdout(root: &Path, args: &[&str]) -> Option<String> {
    glab_run(root, args, false).ok()
}

fn glab_checked(root: &Path, args: &[&str]) -> Result<String, String> {
    glab_run(root, args, false)
}

fn glab_run(root: &Path, args: &[&str], allow_empty: bool) -> Result<String, String> {
    let program = crate::harness::resolve_gui_binary("glab")
        .ok_or_else(|| "GitLab CLI (`glab`) is not installed.".to_string())?;
    let mut cmd = Command::new(&program);
    cmd.current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("PAGER", "cat")
        .env("GLAB_PAGER", "cat")
        .env("NO_COLOR", "1");
    crate::harness::apply_gui_env(&mut cmd);
    let output = cmd.output().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            "GitLab CLI (`glab`) is not installed.".to_string()
        } else {
            error.to_string()
        }
    })?;
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            if allow_empty {
                return Ok(String::new());
            }
            return Err("glab returned no output".into());
        }
        return Ok(text);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("glab {} failed", args.join(" "))
    };
    Err(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_gitlab_work_items_maps_issue_fields() {
        let json = r##"[
          {
            "iid": 12,
            "title": "Design Testing Doctrine",
            "web_url": "https://gitlab.example.com/acme/web/-/issues/12",
            "state": "opened",
            "updated_at": "2026-09-02T12:15:19.504Z",
            "references": { "short": "#12", "relative": "#12", "full": "acme/web#12" },
            "labels": [
              { "id": 110, "name": "in progress", "color": "#ECECEF", "text_color": "#1F1E24" }
            ],
            "assignees": [
              { "id": 23, "username": "douchet", "name": "Thomas Douche",
                "avatar_url": "https://gitlab.example.com/uploads/avatar.png" }
            ]
          }
        ]"##;
        let items = parse_gitlab_work_items(json, "issue").expect("parse");
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.kind, "issue");
        assert_eq!(item.number, 12);
        assert_eq!(item.state, "open");
        assert_eq!(item.repo, "acme/web");
        assert!(!item.draft);
        assert_eq!(item.labels.len(), 1);
        assert_eq!(item.labels[0].name, "in progress");
        assert_eq!(item.labels[0].color, "#ECECEF");
        assert_eq!(item.assignees.len(), 1);
        assert_eq!(item.assignees[0].login, "douchet");
        assert_eq!(item.assignees[0].avatar_url, "");
    }

    #[test]
    fn parse_gitlab_work_items_reads_mr_draft_and_merged() {
        let json = r##"[
          {
            "iid": 1341,
            "title": "Draft: Feat/visualisation support",
            "web_url": "https://gitlab.example.com/acme/web/-/merge_requests/1341",
            "state": "opened",
            "updated_at": "2026-09-07T14:43:47.417Z",
            "draft": true,
            "references": { "full": "acme/web!1341" },
            "labels": [],
            "assignees": [],
            "target_branch": "dev",
            "source_branch": "feat/visualisation-support"
          },
          {
            "iid": 1339,
            "title": "Release/26.08.12.1",
            "web_url": "https://gitlab.example.com/acme/web/-/merge_requests/1339",
            "state": "merged",
            "updated_at": "2026-09-07T09:14:51.164Z",
            "draft": false,
            "references": { "full": "acme/web!1339" },
            "labels": [],
            "assignees": []
          }
        ]"##;
        let items = parse_gitlab_work_items(json, "pr").expect("parse");
        assert_eq!(items.len(), 2);
        assert!(items[0].draft);
        assert_eq!(items[0].state, "open");
        assert_eq!(items[0].repo, "acme/web");
        assert!(!items[1].draft);
        assert_eq!(items[1].state, "merged");
        assert_eq!(items[1].repo, "acme/web");
    }

    #[test]
    fn parse_gitlab_discussions_drops_system_notes_and_nests_replies() {
        let json = r##"[
          {
            "id": "71d9752b8c7cf32cb65bc666802c79417568d1f3",
            "individual_note": true,
            "notes": [
              { "id": 64053, "type": null, "system": true, "resolved": null,
                "body": "changed the description", "created_at": "2026-09-07T14:40:38.411Z",
                "author": { "username": "paulc" }, "position": null }
            ]
          },
          {
            "id": "0662eb7bb1b78a49d8677593e3eb4b16585f8442",
            "individual_note": false,
            "notes": [
              { "id": 62404, "type": "DiffNote", "system": false, "resolved": true,
                "body": "Is raw SQL really justified here?",
                "created_at": "2026-09-01T16:18:58.411Z",
                "author": { "username": "nouchetm" },
                "position": {
                  "base_sha": "5a211eb", "start_sha": "238c2db", "head_sha": "94e0a88",
                  "old_path": "core/infra/query-builder.ts",
                  "new_path": "core/infra/query-builder.ts",
                  "position_type": "text", "old_line": null, "new_line": 210
                }
              },
              { "id": 63128, "type": "DiffNote", "system": false, "resolved": true,
                "body": "We do need raw SQL for this one.",
                "created_at": "2026-09-02T09:11:02.100Z",
                "author": { "username": "paulc" },
                "position": {
                  "old_path": "core/infra/query-builder.ts",
                  "new_path": "core/infra/query-builder.ts",
                  "position_type": "text", "old_line": null, "new_line": 210
                }
              }
            ]
          }
        ]"##;
        let comments = parse_gitlab_discussions(
            json,
            "https://gitlab.example.com/acme/web/-/merge_requests/7",
        )
        .expect("parse");
        assert_eq!(comments.len(), 1);
        let root = &comments[0];
        assert_eq!(root.id, "62404");
        assert_eq!(root.kind, "review_comment");
        assert_eq!(root.author, "nouchetm");
        assert_eq!(root.path, "core/infra/query-builder.ts");
        assert_eq!(root.line, Some(210));
        assert!(root.resolved);
        assert_eq!(root.thread_id, "0662eb7bb1b78a49d8677593e3eb4b16585f8442");
        assert_eq!(
            root.url,
            "https://gitlab.example.com/acme/web/-/merge_requests/7#note_62404"
        );
        assert_eq!(root.replies.len(), 1);
        assert_eq!(root.replies[0].id, "63128");
        assert_eq!(root.replies[0].kind, "comment");
        assert_eq!(root.replies[0].thread_id, root.thread_id);
        assert_eq!(
            root.replies[0].url,
            "https://gitlab.example.com/acme/web/-/merge_requests/7#note_63128"
        );
    }

    #[test]
    fn parse_gitlab_diffs_counts_and_builds_patch() {
        let json = r##"[
          {
            "old_path": "core/domain/run/computation-mesh.test.ts",
            "new_path": "core/domain/run/computation-mesh.test.ts",
            "new_file": true,
            "deleted_file": false,
            "renamed_file": false,
            "diff": "@@ -0,0 +1,2 @@\n+import { it } from 'vitest'\n+\n"
          },
          {
            "old_path": "core/domain/query/validate.ts",
            "new_path": "core/domain/query/validate.ts",
            "new_file": false,
            "deleted_file": false,
            "renamed_file": false,
            "diff": "@@ -12,3 +12,3 @@ const RUN_ID = 'run'\n-type tStateRow = { path: string }\n+type tStateRow = { path: tResultPath }\n const SOLVER_ID = 'a'\n"
          }
        ]"##;
        let diff = parse_gitlab_diffs(json).expect("parse");
        assert!(!diff.truncated);
        assert_eq!(diff.additions, 3);
        assert_eq!(diff.deletions, 1);
        assert_eq!(diff.files.len(), 2);
        assert_eq!(
            diff.files[0].path,
            "core/domain/run/computation-mesh.test.ts"
        );
        assert_eq!(diff.files[0].additions, 2);
        assert_eq!(diff.files[0].deletions, 0);
        assert_eq!(diff.files[1].additions, 1);
        assert_eq!(diff.files[1].deletions, 1);
        assert!(diff.patch.starts_with(
            "diff --git a/core/domain/run/computation-mesh.test.ts b/core/domain/run/computation-mesh.test.ts\n--- /dev/null\n+++ b/core/domain/run/computation-mesh.test.ts\n@@ -0,0 +1,2 @@\n"
        ));
        assert!(diff.patch.contains(
            "diff --git a/core/domain/query/validate.ts b/core/domain/query/validate.ts\n--- a/core/domain/query/validate.ts\n+++ b/core/domain/query/validate.ts\n"
        ));
        assert_eq!(diff.patch.matches("diff --git ").count(), 2);
        assert!(diff.patch.ends_with('\n'));
    }

    #[test]
    fn parse_json_pages_joins_paginated_arrays() {
        let json = r##"[{"iid":1,"state":"opened","references":{"full":"acme/web!1"}}]
[{"iid":2,"state":"merged","references":{"full":"acme/web!2"}}]"##;
        let items = parse_gitlab_work_items(json, "pr").expect("parse");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].number, 1);
        assert_eq!(items[1].number, 2);
    }

    #[test]
    fn work_items_endpoint_encodes_search() {
        let endpoint = work_items_endpoint("pr", true, "all", " fix bug ", 500).expect("endpoint");
        assert!(endpoint.starts_with("projects/:id/merge_requests?"));
        assert!(endpoint.contains("state=all"));
        assert!(endpoint.contains("scope=assigned_to_me"));
        assert!(endpoint.contains("per_page=100"));
        assert!(endpoint.contains("with_labels_details=true"));
        assert!(endpoint.contains("search=fix%20bug"));

        let issues = work_items_endpoint("issue", false, "open", "", 0).expect("endpoint");
        assert!(issues.starts_with("projects/:id/issues?"));
        assert!(issues.contains("state=opened"));
        assert!(issues.contains("scope=all"));
        assert!(issues.contains("per_page=1"));
        assert!(!issues.contains("search="));

        assert_eq!(
            work_items_endpoint("task", false, "open", "", 40),
            Err("Unknown GitLab task kind".to_string())
        );
    }

    #[test]
    fn item_endpoint_rejects_bad_input() {
        assert_eq!(
            item_endpoint("pr", 7).as_deref(),
            Ok("projects/:id/merge_requests/7")
        );
        assert_eq!(
            item_endpoint("issue", 7).as_deref(),
            Ok("projects/:id/issues/7")
        );
        assert_eq!(
            item_endpoint("pr", 0),
            Err("Invalid GitLab item number".to_string())
        );
    }

    #[test]
    fn gitlab_state_normalizes() {
        assert_eq!(gitlab_state("opened"), "open");
        assert_eq!(gitlab_state("locked"), "open");
        assert_eq!(gitlab_state("closed"), "closed");
        assert_eq!(gitlab_state("merged"), "merged");
        assert_eq!(gitlab_state(" merged "), "merged");
        assert_eq!(gitlab_state(""), "open");
    }

    #[test]
    fn valid_discussion_id_rejects_symbols() {
        assert!(valid_discussion_id(
            "0662eb7bb1b78a49d8677593e3eb4b16585f8442"
        ));
        assert!(!valid_discussion_id(""));
        assert!(!valid_discussion_id("abc/../def"));
        assert!(!valid_discussion_id("abc def"));
        assert!(!valid_discussion_id("abc-def"));
        assert!(!valid_discussion_id(&"a".repeat(65)));
    }
}
