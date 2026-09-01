---
name: lumen
description: Operate the Lumen / AgentTube YouTube channel agent through the `lumen` MCP server — check status, generate videos, review scenes and narration, resolve provenance claims, run readiness and DarkzSEO audits, approve and schedule uploads, manage Shorts, strategy, experiments and audience replies — and manage the live YouTube channel itself (branding, banner, sections, videos, playlists, captions, comments, search, analytics). Use whenever the user mentions Lumen, AgentTube, "the channel", "the video pipeline", the dashboard at lumen.trynewways.com, a production/job id, or asks to review, fix, approve, publish or generate a YouTube video, or to change anything on the YouTube channel (name, description, banner, playlists, comments, video metadata).
---

# Operating Lumen through MCP

Lumen runs a YouTube channel end to end with an **approval-first** design: generation is autonomous, publishing never is. You drive it through the `lumen` MCP server (tools appear as `mcp__lumen__<name>`). Every tool goes through Lumen's own REST API, so its gates apply to you exactly as they apply to the dashboard.

## Ground rules

1. **Human attestations stay human.** `factChecked`, `rightsConfirmed`, provenance decisions (supported / waived), approval, Short approval, reply posting, experiment start/adopt, and learning approval are the operator's decisions. Do them only after the operator has explicitly said so in this conversation, and say what you recorded. Never infer consent from "make it ready".
2. **Money needs a sentence first.** Tools that spend provider credits require `confirm=true`. Before passing it, state what will be spent: a full generation is ≈ $1–3 (one `gpt-image-2` image ≈ $0.20 per section, TTS and text are cents); scene visual regeneration ≈ $0.20; narration regeneration is cents; paid video providers are priced per generated second. Rebuilds, renders, audits and readiness (without paid probes) are free (CPU only).
3. **Slow calls are normal.** On the Hetzner instance a rebuild or Short render takes 5–8 minutes and the tool call blocks for that long; a full generation takes 15–25 minutes — queue it, then use `wait_for_job` (it returns after ≤ 9 minutes; call it again). Never re-issue a slow mutating call because it "seems stuck"; check state first with `get_production` / `get_job`.
4. **Prefer summaries.** `get_status`, `list_productions`, `get_production` (summary) are designed to be read whole. Use `get_production detail="full"`, `get_script`, `get_scenes`, `get_dashboard_section` only when you need the specifics.
5. **Read before you write.** Before any edit, fetch the production and quote the current value you are changing.

## Daily review workflow ("get today's video ready")

1. `get_status` → note unread notifications, readiness status, automation state.
2. `list_productions reviewStatus="needs_attention"` then `"needs_review"`.
3. For each production, `get_production`:
   - `blockingFailures` tells you why it cannot be approved. Typical: `provenance` (claims pending), `narration` (stale/missing), scenes not ready.
   - `scenes.needingAttention` lists scenes to repair.
4. **Quality pass** — `get_scenes` and `get_script`. Watch for template residue: "Hey everyone, welcome back", "I've spent months researching", "So that's everything you need to know", field labels such as `call_to_action` or "15 seconds" inside narration. Fix with `edit_scene scriptText=… factualChange=false` (for intros/outros/CTAs), then `regenerate_scene_narration confirm=true`, check that the new audio is not longer than the scene (`get_scenes` durations; widen with `edit_scene duration=`), then `rebuild_video`.
5. **Provenance** — present the pending claims to the operator with a recommendation:
   - general-knowledge claims with no statistic or named study → suggest `waived` with a note;
   - specific numbers, studies, quotes, health/finance/legal → suggest adding a source URL (`sources: [{url, status:"verified"}]`) and marking `supported`, or rewriting the scene to remove the claim.
   Only call `review_provenance` after the operator chooses.
6. **Readiness** — if `get_readiness` is older than 24 h or failing, `run_readiness_check` (free without paid probes).
7. **Discoverability** — `run_discoverability_audit` is free and advisory. Dismiss noise with `review_discoverability_finding status="dismissed" reason=…` when the operator agrees; a common one is "brand missing from title".
8. **Approve** — confirm with the operator: publish time (ISO 8601, channel timezone is Asia/Colombo), privacy (recommend `private` for the first upload of a new format), and both attestations. Then `approve_and_schedule … factChecked=true rightsConfirmed=true confirm=true`. The publish queue runs every 15 minutes and uploads at the publish time.
9. Report: what changed, what was approved, when it uploads, what it cost.

## Generating

- `generate_video topic=… style=explainer length=medium confirm=true` (after stating the cost), then `wait_for_job`. A job that fails at `strategy` or `script` is cheap to `resume_job`; a failure in `production` re-spends images if resumed from `production`.
- `resume_job stage="script"` deliberately regenerates the script and everything after it — use when the script is poor but the strategy is fine.
- The 06:00 (Asia/Colombo) scheduler generates one video per day when a strategy or the default flow is active. `set_automation action="pause"` stops all autonomous spend; say so when the operator wants to stop costs.

## Autonomous operator

`save_strategy` stores objective, audience, pillars, cadence, KPI and budget without starting anything. `start_operator confirm=true` activates it and immediately produces `videosPerRun` videos (each ≈ $1–3). `pause_operator` stops it. Learnings proposed by analytics are visible in `get_status.learning.pending`; approve only when the operator agrees (`review_learning`).

## Shorts

`propose_shorts` → review drafts in `get_production.shorts` → `update_short` (layout `blurred_canvas` is the safest) → `render_short` (free, minutes) → `approve_short confirm=true` (operator decision). Shorts can only be scheduled once the source production is approved.

## Engagement

`sync_engagement` then `get_engagement` for themes/questions; `draft_replies` creates suggestions only; `approve_reply confirm=true` **posts publicly** — read the text back to the operator first.

## Managing the YouTube channel directly (`youtube_*` tools)

These act on the **live channel**, not on Lumen's drafts. Every public-facing change requires `confirm=true`; describe the visible effect first.

- **Channel page**: `youtube_get_channel` → `youtube_update_channel` (name, description ≤1000 chars, keywords, country, default language, trailer), `youtube_set_banner` (local PNG/JPG, 2048×1152), `youtube_list_sections` / `youtube_create_section` / `youtube_delete_section` (home-page layout), `youtube_set_watermark`.
  - A channel tied to a personal Google account may **not** accept a rename via API — the result's `applied.title` says whether it took; if not, the operator renames it in YouTube Studio. YouTube also rate-limits renames.
  - Handle (`@…`), avatar, links and monetisation are Studio-only; say so instead of trying.
- **Videos already on YouTube**: `youtube_list_videos`, `youtube_get_video`, `youtube_update_video` (title/description/tags/category/privacy/scheduled `publishAt`/embeddable/license/made-for-kids/synthetic-media disclosure), `youtube_set_thumbnail`, `youtube_upload_captions` (Lumen's SRT lives in `data/captions/` on the server — download via the production's caption asset URL first), `youtube_delete_video` (irreversible; requires the exact title echoed back).
  - Videos Lumen has scheduled but not yet uploaded are edited in Lumen (`edit_metadata`), not here.
- **Playlists**: `youtube_list_playlists`, `youtube_create_playlist`, `youtube_update_playlist`, `youtube_delete_playlist`, `youtube_list_playlist_items`, `youtube_add_to_playlist`, `youtube_remove_playlist_item`. Good practice after the first few uploads: one playlist per content pillar, then a `multiplePlaylists` home section.
- **Comments (raw)**: `youtube_list_comments`, `youtube_reply_to_comment`, `youtube_post_comment`, `youtube_moderate_comment` (published / heldForReview / rejected, optional ban). Prefer Lumen's engagement flow (`draft_replies` → `approve_reply`) for replies at scale; use the raw tools for one-offs and moderation.
- **Research**: `youtube_search` (100 quota units per call — batch questions, don't loop), `youtube_list_categories`.
- **Analytics**: `youtube_analytics` runs arbitrary YouTube Analytics queries (`channel==MINE`). Requires the *YouTube Analytics API* to be enabled in the Google Cloud project that owns the OAuth client; if it returns `accessNotConfigured`, give the operator the console link from the error and stop.
- Quota: 10,000 units/day shared with Lumen's uploads and comment sync. Reads cost 1, writes/uploads 50, search 100.

## Interpreting states

| Field | Meaning |
|---|---|
| job `interrupted` | the app restarted (or another process opened the DB) mid-run; `resume_job` continues from the last checkpoint |
| review `needs_attention` | a blocking check fails — see `blockingFailures` |
| review `needs_review` | ready for the human gate (attestations + approval) |
| scene `needs_rebuild` | timeline changed; `rebuild_video` |
| narration `stale` | scriptText changed; `regenerate_scene_narration` |
| provenance `blocked` | pending claims remain |
| readiness `warning` | non-blocking items skipped (usually the paid image probe) — fine |

## Errors

- `401` → `LUMEN_API_KEY` / `LUMEN_BASIC_AUTH` not set or wrong in the MCP environment (`.mcp.json` reads `LUMEN_URL`, `LUMEN_API_KEY`, `LUMEN_BASIC_AUTH` from the shell; the project `mise.toml` sets them locally).
- `409` → a gate refused (already published, attestations missing, scene not ready). Read the message; do not retry blindly.
- `412 CONFIRM_REQUIRED` → you called a spend/upload tool without `confirm=true`; state the decision and cost, get the operator's go-ahead, then retry.
- `504` timeout from the MCP → the server is still working; poll with `get_production` / `get_job` rather than repeating the call.

## What not to do

- Do not run `npm start` or `npm test` against the production data directory — both open the SQLite DB and flip running jobs to `interrupted`.
- Do not edit approved or scheduled productions' scenes (Lumen locks them); reject and regenerate instead if something is wrong.
- Do not switch `video_provider` away from `slideshow` or raise `video_max_generated_seconds` without an explicit budget decision from the operator.
