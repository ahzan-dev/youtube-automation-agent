# lumen-mcp

An MCP server that lets Claude Code (or any MCP client) operate a running Lumen / AgentTube instance: check status, queue generations, repair scenes, record review decisions, run readiness and discoverability audits, approve and schedule uploads, manage Shorts, strategy, experiments and audience engagement.

It is a thin client over Lumen's REST API. Nothing bypasses the application: approval gates, cost confirmations and fail-closed publishing apply to the agent exactly as they apply to the dashboard.

## Install

```bash
cd mcp
npm install
```

Requires Node 18+ (uses the built-in `fetch`).

## Configure

| Variable | Purpose |
|---|---|
| `LUMEN_URL` | Base URL of the instance (`http://localhost:3456` by default) |
| `LUMEN_API_KEY` | The instance's `API_KEY` — required for every mutating tool |
| `LUMEN_BASIC_AUTH` | `user:password` if a reverse proxy adds HTTP basic auth (optional) |
| `LUMEN_TIMEOUT_MS` | Default request timeout (optional, 120000). Long operations (rebuild, render, regeneration) use their own longer limits |

The repository ships a `.mcp.json` that registers the server for Claude Code and reads those three variables from your shell environment, so no secrets are committed. Export them (or put them in a local, git-ignored `mise.toml` / `.envrc`) before starting Claude Code in the repo:

```bash
export LUMEN_URL=https://lumen.example.com
export LUMEN_API_KEY=…
export LUMEN_BASIC_AUTH=user:password   # only if you use basic auth
```

Long tool calls: a rebuild or a Short render can take several minutes on a small server. If your MCP client enforces a per-call timeout, raise it (Claude Code: `export MCP_TOOL_TIMEOUT=900000`).

## Run manually

```bash
node mcp/server.mjs         # stdio transport; logs go to stderr
```

## Tools

88 tools in nine groups. Read tools are annotated read-only; anything that spends provider credits or leads to a YouTube upload requires `confirm: true` and says so in its description.

- **Status**: `get_status`, `get_dashboard_section`, `get_schedule`, `get_analytics`, `get_outcomes`, `mark_notification_read`
- **Generation**: `generate_video`, `get_job`, `wait_for_job`, `resume_job`, `cancel_job`, `create_idea`, `update_idea`, `generate_from_idea`
- **Readiness**: `get_readiness`, `run_readiness_check`
- **Cost**: `get_usage` — OpenAI spend recorded from each response's usage object (per day / model / production)
- **Review**: `list_productions`, `get_production`, `get_script`, `get_scenes`, `edit_metadata`, `review_provenance`, `run_discoverability_audit`, `review_discoverability_finding`
- **Scene repair**: `edit_scene`, `reorder_scenes`, `estimate_scene_regeneration`, `regenerate_scene_visual`, `regenerate_scene_narration`, `set_intentional_silence`, `rebuild_video`
- **Publishing**: `approve_and_schedule`, `unschedule_production`, `reject_production`, `retry_production`, Shorts: `propose_shorts`, `update_short`, `render_short`, `approve_short`
- **Channel operations**: `update_profile`, `save_strategy`, `start_operator`, `pause_operator`, `resume_operator_run`, `cancel_operator_run`, `review_learning`, `set_automation`, `update_settings`
- **YouTube channel (direct API)**: `youtube_get_channel`, `youtube_update_channel`, `youtube_set_banner`, `youtube_set_watermark`, `youtube_remove_watermark`, sections (`youtube_list_sections`, `youtube_create_section`, `youtube_delete_section`), videos (`youtube_list_videos`, `youtube_get_video`, `youtube_update_video`, `youtube_set_thumbnail`, `youtube_delete_video`, `youtube_list_categories`), captions (`youtube_list_captions`, `youtube_upload_captions`, `youtube_delete_caption`), playlists (`youtube_list_playlists`, `youtube_create_playlist`, `youtube_update_playlist`, `youtube_delete_playlist`, `youtube_list_playlist_items`, `youtube_add_to_playlist`, `youtube_remove_playlist_item`), comments (`youtube_list_comments`, `youtube_reply_to_comment`, `youtube_post_comment`, `youtube_moderate_comment`), `youtube_search`, `youtube_analytics`
- **Growth & audience**: `list_experiments`, `create_experiment`, `experiment_action`, `get_retention`, `refresh_retention`, `get_engagement`, `sync_engagement`, `draft_replies`, `update_reply_draft`, `approve_reply`

The companion skill in `.claude/skills/lumen/SKILL.md` teaches Claude Code the review workflow, cost model and the rule that approvals and attestations remain human decisions.

## Files

- `server.mjs` — stdio entrypoint, configuration, server instructions
- `lumen-client.mjs` — HTTP client (auth headers, envelope unwrapping, per-call timeouts, typed errors)
- `tools.mjs` — Lumen tool registrations, input schemas, result summarisers, confirm guards
- `youtube-tools.mjs` — direct YouTube channel tools (backed by Lumen's `/api/youtube` routes, which use the channel's existing OAuth grant)
