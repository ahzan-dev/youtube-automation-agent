// YouTube channel-management tools (direct YouTube Data / Analytics API via
// Lumen's /api/youtube routes). Everything public-facing — renaming the
// channel, changing video visibility, posting/deleting, moderating — requires
// confirm=true so the agent states the consequence to the operator first.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { LumenError } from './lumen-client.mjs';

const PRIVACY = ['private', 'unlisted', 'public'];
const readOnly = { readOnlyHint: true, openWorldHint: true };
const mutating = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.sbv': 'text/plain', '.txt': 'text/plain' };

function json(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function failure(error) {
  const payload = error instanceof LumenError
    ? { error: error.message, status: error.status, code: error.code, details: error.details, path: error.path }
    : { error: error.message };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
function requireConfirm(confirm, what) {
  if (confirm !== true) throw new LumenError(`Refused: ${what} requires confirm=true. Tell the operator what will change publicly on YouTube, then call again with confirm=true.`, { status: 412, code: 'CONFIRM_REQUIRED' });
}
async function readLocalFile(filePath, kind) {
  try {
    const buffer = await readFile(filePath);
    const mimeType = MIME[path.extname(filePath).toLowerCase()];
    if (!mimeType) throw new LumenError(`Unsupported ${kind} file type: ${path.extname(filePath)} (use ${Object.keys(MIME).join(', ')})`, { status: 400 });
    return { buffer, mimeType };
  } catch (error) {
    if (error instanceof LumenError) throw error;
    throw new LumenError(`Cannot read ${kind} file ${filePath}: ${error.message} (the path must exist on the machine running the MCP server)`, { status: 400 });
  }
}

export function registerYouTubeTools(server, client) {
  const tool = (name, config, handler) => server.registerTool(name, config, async (args) => {
    try { return await handler(args || {}); } catch (error) { return failure(error); }
  });

  // -------------------------------------------------------------- channel
  tool('youtube_get_channel', {
    title: 'YouTube channel', description: 'The linked YouTube channel: id, handle, title, description, country, keywords, banner, trailer, subscriber/view/video counts, uploads playlist id, and which settings can only be changed in YouTube Studio (handle, avatar, links).',
    inputSchema: {}, annotations: readOnly
  }, async () => json(await client.get('/api/youtube/channel')));

  tool('youtube_update_channel', {
    title: 'Update channel branding',
    description: 'Change channel title (name), description (≤1000 chars), keywords, country (ISO-2, e.g. LK), default language, or the trailer video for non-subscribers. PUBLIC, immediate; YouTube rate-limits renames and may refuse a rename for channels tied to a personal Google account (the result reports whether each field actually applied). Requires confirm=true.',
    inputSchema: {
      title: z.string().min(1).max(100).optional(), description: z.string().max(1000).optional(), keywords: z.array(z.string()).max(50).optional(),
      country: z.string().regex(/^[A-Za-z]{2}$/).optional(), defaultLanguage: z.string().max(10).optional(), unsubscribedTrailer: z.string().optional().describe('video id, or empty string to clear'),
      confirm: z.boolean()
    }, annotations: destructive
  }, async ({ confirm, ...input }) => { requireConfirm(confirm, 'youtube_update_channel (changes the public channel page)'); return json(await client.put('/api/youtube/channel/branding', input)); });

  tool('youtube_set_banner', {
    title: 'Set channel banner', description: 'Upload a local image (PNG/JPG, ≤6 MB, 2048×1152 recommended) as the channel banner. PUBLIC. Requires confirm=true.',
    inputSchema: { filePath: z.string().describe('Local path on the MCP host'), confirm: z.boolean() }, annotations: destructive
  }, async ({ filePath, confirm }) => { requireConfirm(confirm, 'youtube_set_banner'); const { buffer, mimeType } = await readLocalFile(filePath, 'banner'); return json(await client.upload('PUT', '/api/youtube/channel/banner', buffer, mimeType, undefined, { timeoutMs: 300_000 })); });

  tool('youtube_set_watermark', {
    title: 'Set video watermark', description: 'Upload a small PNG shown as the channel branding watermark on all videos (corner, optional timing). PUBLIC. Requires confirm=true.',
    inputSchema: { filePath: z.string(), offsetMs: z.number().int().min(0).default(0), durationMs: z.number().int().min(1000).optional(), corner: z.enum(['topLeft', 'topRight', 'bottomLeft', 'bottomRight']).default('topRight'), confirm: z.boolean() }, annotations: destructive
  }, async ({ filePath, confirm, ...query }) => { requireConfirm(confirm, 'youtube_set_watermark'); const { buffer, mimeType } = await readLocalFile(filePath, 'watermark'); return json(await client.upload('PUT', '/api/youtube/channel/watermark', buffer, mimeType, query, { timeoutMs: 300_000 })); });

  tool('youtube_remove_watermark', { title: 'Remove watermark', description: 'Remove the channel branding watermark. Requires confirm=true.', inputSchema: { confirm: z.boolean() }, annotations: destructive },
    async ({ confirm }) => { requireConfirm(confirm, 'youtube_remove_watermark'); return json(await client.request('DELETE', '/api/youtube/channel/watermark')); });

  tool('youtube_list_sections', { title: 'Channel page sections', description: 'Sections shown on the channel home page (recent uploads, playlists, …).', inputSchema: {}, annotations: readOnly },
    async () => json(await client.get('/api/youtube/channel/sections')));

  tool('youtube_create_section', {
    title: 'Add channel section', description: 'Add a home-page section: recentUploads, popularUploads, singlePlaylist (playlists=[id]), multiplePlaylists (playlists=[ids], title), allPlaylists, likes, subscriptions, multipleChannels (channels=[ids]). PUBLIC. Requires confirm=true.',
    inputSchema: { type: z.string(), title: z.string().max(100).optional(), playlists: z.array(z.string()).optional(), channels: z.array(z.string()).optional(), position: z.number().int().min(0).optional(), confirm: z.boolean() }, annotations: mutating
  }, async ({ confirm, ...input }) => { requireConfirm(confirm, 'youtube_create_section'); return json(await client.post('/api/youtube/channel/sections', input)); });

  tool('youtube_delete_section', { title: 'Delete channel section', description: 'Remove a home-page section by id. Requires confirm=true.', inputSchema: { sectionId: z.string(), confirm: z.boolean() }, annotations: destructive },
    async ({ sectionId, confirm }) => { requireConfirm(confirm, 'youtube_delete_section'); return json(await client.request('DELETE', `/api/youtube/channel/sections/${encodeURIComponent(sectionId)}`)); });

  // --------------------------------------------------------------- videos
  tool('youtube_list_videos', { title: 'List uploads', description: 'Videos on the channel (all privacy states) with status and view/like/comment counts. Paginate with pageToken.', inputSchema: { maxResults: z.number().int().min(1).max(50).default(25), pageToken: z.string().optional() }, annotations: readOnly },
    async ({ maxResults, pageToken }) => json(await client.get('/api/youtube/videos', { maxResults, pageToken })));

  tool('youtube_get_video', { title: 'Get video', description: 'One video by YouTube id: metadata, status (privacy, scheduled publishAt, rejection reason), statistics.', inputSchema: { videoId: z.string() }, annotations: readOnly },
    async ({ videoId }) => json(await client.get(`/api/youtube/videos/${encodeURIComponent(videoId)}`)));

  tool('youtube_update_video', {
    title: 'Update video', description: 'Edit a published/uploaded video on YouTube: title, description, tags, categoryId, defaultLanguage, privacyStatus, publishAt (needs privacyStatus=private), embeddable, license, selfDeclaredMadeForKids, containsSyntheticMedia disclosure. PUBLIC for public videos. Requires confirm=true. Note: Lumen\'s own scheduled uploads should be edited in Lumen before they publish; use this for videos already on YouTube.',
    inputSchema: {
      videoId: z.string(), title: z.string().min(1).max(100).optional(), description: z.string().max(5000).optional(), tags: z.array(z.string()).optional(), categoryId: z.string().optional(),
      defaultLanguage: z.string().optional(), defaultAudioLanguage: z.string().optional(), privacyStatus: z.enum(PRIVACY).optional(), publishAt: z.string().optional(),
      embeddable: z.boolean().optional(), license: z.enum(['youtube', 'creativeCommon']).optional(), selfDeclaredMadeForKids: z.boolean().optional(), containsSyntheticMedia: z.boolean().optional(), confirm: z.boolean()
    }, annotations: destructive
  }, async ({ videoId, confirm, ...input }) => { requireConfirm(confirm, 'youtube_update_video'); return json(await client.patch(`/api/youtube/videos/${encodeURIComponent(videoId)}`, input)); });

  tool('youtube_set_thumbnail', { title: 'Set video thumbnail', description: 'Upload a local image (≤2 MB, 1280×720) as a video\'s custom thumbnail. Requires a phone-verified YouTube account. Requires confirm=true.', inputSchema: { videoId: z.string(), filePath: z.string(), confirm: z.boolean() }, annotations: destructive },
    async ({ videoId, filePath, confirm }) => { requireConfirm(confirm, 'youtube_set_thumbnail'); const { buffer, mimeType } = await readLocalFile(filePath, 'thumbnail'); return json(await client.upload('PUT', `/api/youtube/videos/${encodeURIComponent(videoId)}/thumbnail`, buffer, mimeType, undefined, { timeoutMs: 300_000 })); });

  tool('youtube_delete_video', { title: 'Delete video', description: 'PERMANENTLY delete a video from YouTube. Irreversible. Requires confirm=true and the exact title echoed back in expectedTitle as a second check.', inputSchema: { videoId: z.string(), expectedTitle: z.string(), confirm: z.boolean() }, annotations: destructive },
    async ({ videoId, expectedTitle, confirm }) => {
      requireConfirm(confirm, 'youtube_delete_video (irreversible)');
      const video = await client.get(`/api/youtube/videos/${encodeURIComponent(videoId)}`);
      if (video.title !== expectedTitle) throw new LumenError(`Refused: expectedTitle "${expectedTitle}" does not match the video title "${video.title}"`, { status: 412 });
      return json(await client.request('DELETE', `/api/youtube/videos/${encodeURIComponent(videoId)}`));
    });

  tool('youtube_list_categories', { title: 'Video categories', description: 'Assignable video category ids for a region (e.g. 27 Education, 28 Science & Technology, 22 People & Blogs).', inputSchema: { regionCode: z.string().length(2).default('US') }, annotations: readOnly },
    async ({ regionCode }) => json(await client.get('/api/youtube/categories', { regionCode })));

  // ------------------------------------------------------------- captions
  tool('youtube_list_captions', { title: 'List caption tracks', description: 'Caption tracks on a video (language, name, draft state).', inputSchema: { videoId: z.string() }, annotations: readOnly },
    async ({ videoId }) => json(await client.get(`/api/youtube/videos/${encodeURIComponent(videoId)}/captions`)));

  tool('youtube_upload_captions', { title: 'Upload caption track', description: 'Upload a local .srt/.vtt/.sbv file as a caption track for a video (e.g. Lumen\'s generated SRT). Requires confirm=true.', inputSchema: { videoId: z.string(), filePath: z.string(), language: z.string().default('en'), name: z.string().max(150).default(''), isDraft: z.boolean().default(false), confirm: z.boolean() }, annotations: mutating },
    async ({ videoId, filePath, confirm, ...query }) => { requireConfirm(confirm, 'youtube_upload_captions'); const { buffer, mimeType } = await readLocalFile(filePath, 'caption'); return json(await client.upload('PUT', `/api/youtube/videos/${encodeURIComponent(videoId)}/captions`, buffer, mimeType, query, { timeoutMs: 300_000 })); });

  tool('youtube_delete_caption', { title: 'Delete caption track', description: 'Delete a caption track by id. Requires confirm=true.', inputSchema: { captionId: z.string(), confirm: z.boolean() }, annotations: destructive },
    async ({ captionId, confirm }) => { requireConfirm(confirm, 'youtube_delete_caption'); return json(await client.request('DELETE', `/api/youtube/captions/${encodeURIComponent(captionId)}`)); });

  // ------------------------------------------------------------ playlists
  tool('youtube_list_playlists', { title: 'List playlists', description: 'The channel\'s playlists with item counts and privacy.', inputSchema: { maxResults: z.number().int().min(1).max(50).default(50), pageToken: z.string().optional() }, annotations: readOnly },
    async ({ maxResults, pageToken }) => json(await client.get('/api/youtube/playlists', { maxResults, pageToken })));

  tool('youtube_create_playlist', { title: 'Create playlist', description: 'Create a playlist (title ≤150, description, privacy). Requires confirm=true.', inputSchema: { title: z.string().min(1).max(150), description: z.string().max(5000).default(''), privacyStatus: z.enum(PRIVACY).default('public'), confirm: z.boolean() }, annotations: mutating },
    async ({ confirm, ...input }) => { requireConfirm(confirm, 'youtube_create_playlist'); return json(await client.post('/api/youtube/playlists', input)); });

  tool('youtube_update_playlist', { title: 'Update playlist', description: 'Change a playlist\'s title, description or privacy. Requires confirm=true.', inputSchema: { playlistId: z.string(), title: z.string().max(150).optional(), description: z.string().max(5000).optional(), privacyStatus: z.enum(PRIVACY).optional(), confirm: z.boolean() }, annotations: mutating },
    async ({ playlistId, confirm, ...input }) => { requireConfirm(confirm, 'youtube_update_playlist'); return json(await client.patch(`/api/youtube/playlists/${encodeURIComponent(playlistId)}`, input)); });

  tool('youtube_delete_playlist', { title: 'Delete playlist', description: 'Delete a playlist (videos stay on the channel). Requires confirm=true.', inputSchema: { playlistId: z.string(), confirm: z.boolean() }, annotations: destructive },
    async ({ playlistId, confirm }) => { requireConfirm(confirm, 'youtube_delete_playlist'); return json(await client.request('DELETE', `/api/youtube/playlists/${encodeURIComponent(playlistId)}`)); });

  tool('youtube_list_playlist_items', { title: 'List playlist items', description: 'Videos in a playlist, in order.', inputSchema: { playlistId: z.string(), maxResults: z.number().int().min(1).max(50).default(50), pageToken: z.string().optional() }, annotations: readOnly },
    async ({ playlistId, maxResults, pageToken }) => json(await client.get(`/api/youtube/playlists/${encodeURIComponent(playlistId)}/items`, { maxResults, pageToken })));

  tool('youtube_add_to_playlist', { title: 'Add video to playlist', description: 'Add a video to a playlist at an optional position.', inputSchema: { playlistId: z.string(), videoId: z.string(), position: z.number().int().min(0).optional() }, annotations: mutating },
    async ({ playlistId, ...input }) => json(await client.post(`/api/youtube/playlists/${encodeURIComponent(playlistId)}/items`, input)));

  tool('youtube_remove_playlist_item', { title: 'Remove playlist item', description: 'Remove an item (by playlistItem id from youtube_list_playlist_items) from a playlist.', inputSchema: { itemId: z.string() }, annotations: mutating },
    async ({ itemId }) => json(await client.request('DELETE', `/api/youtube/playlist-items/${encodeURIComponent(itemId)}`)));

  // ------------------------------------------------------------- comments
  tool('youtube_list_comments', { title: 'List comments', description: 'Comment threads on a video with replies and moderation status (raw YouTube view; Lumen\'s get_engagement gives the analysed view).', inputSchema: { videoId: z.string(), maxResults: z.number().int().min(1).max(100).default(50), order: z.enum(['time', 'relevance']).default('time'), searchTerms: z.string().optional(), pageToken: z.string().optional() }, annotations: readOnly },
    async ({ videoId, ...query }) => json(await client.get(`/api/youtube/videos/${encodeURIComponent(videoId)}/comments`, query)));

  tool('youtube_reply_to_comment', { title: 'Reply to comment', description: 'Post a reply to a comment in the channel\'s name. PUBLIC and immediate. Read the text back to the operator first. Requires confirm=true.', inputSchema: { commentId: z.string(), text: z.string().min(1).max(10000), confirm: z.boolean() }, annotations: destructive },
    async ({ commentId, text, confirm }) => { requireConfirm(confirm, 'youtube_reply_to_comment (posts publicly)'); return json(await client.post(`/api/youtube/comments/${encodeURIComponent(commentId)}/reply`, { text })); });

  tool('youtube_post_comment', { title: 'Post top-level comment', description: 'Post a new top-level comment on one of the channel\'s videos (e.g. a pinned-style note). PUBLIC. Requires confirm=true.', inputSchema: { videoId: z.string(), text: z.string().min(1).max(10000), confirm: z.boolean() }, annotations: destructive },
    async ({ videoId, text, confirm }) => { requireConfirm(confirm, 'youtube_post_comment (posts publicly)'); return json(await client.post(`/api/youtube/videos/${encodeURIComponent(videoId)}/comments`, { text })); });

  tool('youtube_moderate_comment', { title: 'Moderate comment', description: 'Set a comment\'s moderation status: published, heldForReview, or rejected (optionally banAuthor). Requires confirm=true.', inputSchema: { commentId: z.string(), moderationStatus: z.enum(['published', 'heldForReview', 'rejected']), banAuthor: z.boolean().default(false), confirm: z.boolean() }, annotations: destructive },
    async ({ commentId, confirm, ...input }) => { requireConfirm(confirm, 'youtube_moderate_comment'); return json(await client.post(`/api/youtube/comments/${encodeURIComponent(commentId)}/moderate`, input)); });

  // ------------------------------------------------- research & analytics
  tool('youtube_search', { title: 'Search YouTube', description: 'Public YouTube search for research (competitors, topic saturation). Returns titles, channels, dates and — for videos — views/likes/duration. Costs 100 API quota units per call (daily quota 10,000).', inputSchema: { q: z.string().optional(), type: z.enum(['video', 'channel', 'playlist']).default('video'), order: z.enum(['relevance', 'date', 'viewCount', 'rating', 'title']).default('relevance'), maxResults: z.number().int().min(1).max(50).default(10), regionCode: z.string().length(2).optional(), publishedAfter: z.string().optional().describe('RFC 3339, e.g. 2026-08-01T00:00:00Z'), channelId: z.string().optional(), videoDuration: z.enum(['short', 'medium', 'long']).optional() }, annotations: readOnly },
    async query => json(await client.get('/api/youtube/search', query)));

  tool('youtube_analytics', { title: 'YouTube Analytics query', description: 'Raw YouTube Analytics for the channel. metrics e.g. views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, subscribersLost, likes, comments, shares, impressions (day dimension only), impressionClickThroughRate; dimensions e.g. day, video, country, trafficSourceType, deviceType, ageGroup, gender; filters e.g. "video==ID"; sort e.g. "-views".', inputSchema: { startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), metrics: z.array(z.string()).optional(), dimensions: z.array(z.string()).optional(), filters: z.string().optional(), sort: z.string().optional(), maxResults: z.number().int().min(1).max(200).optional() }, annotations: readOnly },
    async ({ metrics, dimensions, ...rest }) => json(await client.get('/api/youtube/analytics', { ...rest, metrics: metrics?.join(','), dimensions: dimensions?.join(',') })));
}
