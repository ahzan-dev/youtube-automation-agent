const { Readable } = require('stream');
const { google } = require('googleapis');
const { Logger } = require('./logger');

// Direct YouTube channel management on top of the channel's existing OAuth
// grant (full `youtube` scope + `yt-analytics.readonly`): branding, uploads,
// playlists, sections, watermark, comments, captions, search and analytics.
//
// Lumen's own pipeline never calls this; it exists so an operator (or an MCP
// client acting for one) can manage the channel without leaving the tool.
// Every method returns plain JSON and normalises Google API errors.
//
// Quota notes (default 10,000 units/day): reads cost 1, writes 50, uploads
// (banner, thumbnail, caption, watermark) 50, search.list 100.

const VIDEO_PRIVACY = new Set(['private', 'unlisted', 'public']);
const MODERATION = new Set(['published', 'heldForReview', 'rejected']);
const SECTION_TYPES = new Set([
  'allPlaylists', 'completedEvents', 'likedPlaylists', 'likes', 'liveEvents', 'multipleChannels',
  'multiplePlaylists', 'popularUploads', 'postedPlaylists', 'postedVideos', 'recentPosts',
  'recentUploads', 'singlePlaylist', 'subscriptions', 'upcomingEvents'
]);

class YouTubeError extends Error {
  constructor(message, { status = 500, reason = null, details = null } = {}) {
    super(message);
    this.name = 'YouTubeError';
    this.status = status;
    this.reason = reason;
    this.details = details;
  }
}

function normalizeError(error, action) {
  if (error instanceof YouTubeError) return error;
  const status = Number(error?.code || error?.response?.status) || 500;
  const first = error?.errors?.[0] || error?.response?.data?.error?.errors?.[0] || {};
  const message = first.message || error?.response?.data?.error?.message || error?.message || 'YouTube API request failed';
  const reason = first.reason || null;
  const hints = {
    quotaExceeded: 'Daily YouTube API quota is exhausted; it resets at midnight Pacific time.',
    forbidden: 'The OAuth grant does not allow this action or the resource belongs to another channel.',
    insufficientPermissions: 'Re-authorise YouTube with the full youtube scope (npm run walkthrough).',
    invalidCredentials: 'The stored OAuth token is invalid or revoked; re-authorise YouTube.',
    rateLimitExceeded: 'YouTube rate limit hit; wait and retry.'
  };
  return new YouTubeError(`${action}: ${message}${hints[reason] ? ` — ${hints[reason]}` : ''}`, { status, reason, details: error?.errors || null });
}

const arr = value => (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]);
const num = value => (value === undefined || value === null || value === '' ? undefined : Number(value));

class YouTubeChannelService {
  constructor(credentialManager, options = {}) {
    this.credentials = credentialManager;
    this.logger = options.logger || new Logger('YouTubeChannel');
    this.clientFactory = options.clientFactory || null;
    this._channelId = null;
  }

  clients() {
    if (this.clientFactory) return this.clientFactory();
    const auth = this.credentials.getYouTubeAuth();
    return {
      youtube: google.youtube({ version: 'v3', auth }),
      analytics: google.youtubeAnalytics({ version: 'v2', auth })
    };
  }

  async call(action, fn) {
    try {
      return await fn(this.clients());
    } catch (error) {
      const normalized = normalizeError(error, action);
      this.logger.warn(normalized.message);
      throw normalized;
    }
  }

  // ---------------------------------------------------------------- channel
  async rawChannel(youtube) {
    const response = await youtube.channels.list({
      part: ['snippet', 'brandingSettings', 'statistics', 'contentDetails', 'status'],
      mine: true
    });
    const channel = response.data.items?.[0];
    if (!channel) throw new YouTubeError('No YouTube channel is linked to the authorised account', { status: 404, reason: 'channelNotFound' });
    this._channelId = channel.id;
    return channel;
  }

  summarizeChannel(channel) {
    const branding = channel.brandingSettings || {};
    return {
      id: channel.id,
      handle: channel.snippet?.customUrl || null,
      title: channel.snippet?.title,
      description: channel.snippet?.description || '',
      country: channel.snippet?.country || branding.channel?.country || null,
      defaultLanguage: channel.snippet?.defaultLanguage || branding.channel?.defaultLanguage || null,
      keywords: branding.channel?.keywords || '',
      unsubscribedTrailer: branding.channel?.unsubscribedTrailer || null,
      bannerUrl: branding.image?.bannerExternalUrl || null,
      thumbnails: channel.snippet?.thumbnails ? Object.fromEntries(Object.entries(channel.snippet.thumbnails).map(([k, v]) => [k, v.url])) : {},
      publishedAt: channel.snippet?.publishedAt,
      statistics: {
        subscribers: channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount ?? 0),
        subscribersHidden: Boolean(channel.statistics?.hiddenSubscriberCount),
        views: Number(channel.statistics?.viewCount ?? 0),
        videos: Number(channel.statistics?.videoCount ?? 0)
      },
      uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads || null,
      status: {
        privacyStatus: channel.status?.privacyStatus, isLinked: channel.status?.isLinked,
        longUploadsStatus: channel.status?.longUploadsStatus, madeForKids: channel.status?.madeForKids
      },
      managedOnlyInStudio: ['handle (@name)', 'profile picture', 'links section', 'audience (made for kids) default', 'monetisation']
    };
  }

  getChannel() {
    return this.call('Read channel', async ({ youtube }) => this.summarizeChannel(await this.rawChannel(youtube)));
  }

  async channelId() {
    if (this._channelId) return this._channelId;
    await this.getChannel();
    return this._channelId;
  }

  /**
   * Update channel branding. Only the supplied fields change; the rest are
   * re-sent from the current channel so the API does not blank them.
   */
  updateBranding(input = {}) {
    return this.call('Update channel branding', async ({ youtube }) => {
      const current = await this.rawChannel(youtube);
      const channel = { ...(current.brandingSettings?.channel || {}) };
      const changes = {};
      if (input.title !== undefined) {
        const title = String(input.title).trim();
        if (!title || title.length > 100) throw new YouTubeError('title must be 1–100 characters', { status: 400 });
        channel.title = title; changes.title = title;
      }
      if (input.description !== undefined) {
        const description = String(input.description);
        if (description.length > 1000) throw new YouTubeError('description must be 1000 characters or less', { status: 400 });
        channel.description = description; changes.description = description;
      }
      if (input.keywords !== undefined) {
        const keywords = Array.isArray(input.keywords)
          ? input.keywords.map(k => (/\s/.test(k) ? `"${k}"` : k)).join(' ')
          : String(input.keywords);
        if (keywords.length > 500) throw new YouTubeError('keywords must total 500 characters or less', { status: 400 });
        channel.keywords = keywords; changes.keywords = keywords;
      }
      if (input.country !== undefined) {
        const country = String(input.country).toUpperCase();
        if (!/^[A-Z]{2}$/.test(country)) throw new YouTubeError('country must be a two-letter ISO code (e.g. LK)', { status: 400 });
        channel.country = country; changes.country = country;
      }
      if (input.defaultLanguage !== undefined) { channel.defaultLanguage = String(input.defaultLanguage); changes.defaultLanguage = channel.defaultLanguage; }
      if (input.unsubscribedTrailer !== undefined) { channel.unsubscribedTrailer = input.unsubscribedTrailer || ''; changes.unsubscribedTrailer = channel.unsubscribedTrailer; }
      if (!Object.keys(changes).length) throw new YouTubeError('No branding fields supplied', { status: 400 });

      const requestBody = { id: current.id, brandingSettings: { channel } };
      const response = await youtube.channels.update({ part: ['brandingSettings'], requestBody });
      const after = this.summarizeChannel(await this.rawChannel(youtube));
      const applied = {};
      for (const [key, value] of Object.entries(changes)) {
        const actual = key === 'title' ? after.title : after[key];
        applied[key] = { requested: value, now: actual, applied: String(actual ?? '') === String(value ?? '') };
      }
      if (changes.title && !applied.title.applied) {
        applied.title.note = 'YouTube accepted the request but the channel name did not change. Names tied to a Google account (not a Brand Account) can only be renamed in YouTube Studio, and YouTube rate-limits renames.';
      }
      return { applied, channel: after, apiResponseTitle: response.data?.brandingSettings?.channel?.title };
    });
  }

  setBanner(buffer, mimeType) {
    return this.call('Set channel banner', async ({ youtube }) => {
      if (!buffer?.length) throw new YouTubeError('Banner image body is empty', { status: 400 });
      if (buffer.length > 6 * 1024 * 1024) throw new YouTubeError('Banner must be 6 MB or less', { status: 400 });
      const current = await this.rawChannel(youtube);
      const upload = await youtube.channelBanners.insert({ media: { mimeType: mimeType || 'image/png', body: Readable.from(buffer) } });
      const url = upload.data?.url;
      if (!url) throw new YouTubeError('YouTube did not return a banner URL', { status: 502 });
      await youtube.channels.update({
        part: ['brandingSettings'],
        requestBody: { id: current.id, brandingSettings: { channel: current.brandingSettings?.channel || {}, image: { bannerExternalUrl: url } } }
      });
      return { bannerUrl: url, note: 'YouTube renders the banner across devices from this image; 2048×1152 with the safe area centred is recommended.' };
    });
  }

  // ----------------------------------------------------------------- videos
  summarizeVideo(video) {
    return {
      id: video.id,
      title: video.snippet?.title,
      description: video.snippet?.description,
      tags: video.snippet?.tags || [],
      categoryId: video.snippet?.categoryId,
      publishedAt: video.snippet?.publishedAt,
      defaultLanguage: video.snippet?.defaultLanguage || null,
      thumbnail: video.snippet?.thumbnails?.high?.url || video.snippet?.thumbnails?.default?.url || null,
      duration: video.contentDetails?.duration || null,
      definition: video.contentDetails?.definition,
      caption: video.contentDetails?.caption === 'true',
      status: {
        privacyStatus: video.status?.privacyStatus, uploadStatus: video.status?.uploadStatus, publishAt: video.status?.publishAt || null,
        license: video.status?.license, embeddable: video.status?.embeddable, madeForKids: video.status?.madeForKids,
        selfDeclaredMadeForKids: video.status?.selfDeclaredMadeForKids, rejectionReason: video.status?.rejectionReason || null
      },
      statistics: video.statistics ? {
        views: Number(video.statistics.viewCount ?? 0), likes: Number(video.statistics.likeCount ?? 0),
        comments: Number(video.statistics.commentCount ?? 0)
      } : null,
      url: `https://www.youtube.com/watch?v=${video.id}`
    };
  }

  listVideos({ maxResults = 25, pageToken } = {}) {
    return this.call('List uploads', async ({ youtube }) => {
      const channel = await this.rawChannel(youtube);
      const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) return { items: [], nextPageToken: null };
      const page = await youtube.playlistItems.list({ part: ['contentDetails'], playlistId: uploads, maxResults: Math.min(50, Math.max(1, maxResults)), pageToken });
      const ids = (page.data.items || []).map(item => item.contentDetails.videoId);
      if (!ids.length) return { items: [], nextPageToken: page.data.nextPageToken || null };
      const videos = await youtube.videos.list({ part: ['snippet', 'status', 'statistics', 'contentDetails'], id: ids });
      return { items: (videos.data.items || []).map(v => this.summarizeVideo(v)), nextPageToken: page.data.nextPageToken || null, total: channel.statistics?.videoCount };
    });
  }

  getVideo(videoId) {
    return this.call('Read video', async ({ youtube }) => {
      const response = await youtube.videos.list({ part: ['snippet', 'status', 'statistics', 'contentDetails'], id: [videoId] });
      const video = response.data.items?.[0];
      if (!video) throw new YouTubeError(`Video ${videoId} not found (or not visible to this account)`, { status: 404 });
      return this.summarizeVideo(video);
    });
  }

  updateVideo(videoId, input = {}) {
    return this.call('Update video', async ({ youtube }) => {
      const response = await youtube.videos.list({ part: ['snippet', 'status'], id: [videoId] });
      const video = response.data.items?.[0];
      if (!video) throw new YouTubeError(`Video ${videoId} not found`, { status: 404 });
      const snippet = { ...video.snippet };
      const status = { ...video.status };
      const changes = {};
      const setSnippet = (key, value, validate) => { if (value === undefined) return; if (validate) validate(value); snippet[key] = value; changes[key] = value; };
      setSnippet('title', input.title, v => { if (!v || String(v).length > 100) throw new YouTubeError('title must be 1–100 characters', { status: 400 }); });
      setSnippet('description', input.description, v => { if (String(v).length > 5000) throw new YouTubeError('description must be 5000 characters or less', { status: 400 }); });
      setSnippet('tags', input.tags === undefined ? undefined : arr(input.tags).map(String), v => { if (v.join(',').length > 500) throw new YouTubeError('tags must total 500 characters or less', { status: 400 }); });
      setSnippet('categoryId', input.categoryId === undefined ? undefined : String(input.categoryId));
      setSnippet('defaultLanguage', input.defaultLanguage);
      setSnippet('defaultAudioLanguage', input.defaultAudioLanguage);
      if (input.privacyStatus !== undefined) {
        if (!VIDEO_PRIVACY.has(input.privacyStatus)) throw new YouTubeError('privacyStatus must be private, unlisted or public', { status: 400 });
        status.privacyStatus = input.privacyStatus; changes.privacyStatus = input.privacyStatus;
      }
      if (input.publishAt !== undefined) {
        if (input.publishAt && status.privacyStatus !== 'private') throw new YouTubeError('publishAt (scheduled premiere/publish) requires privacyStatus=private until that time', { status: 400 });
        status.publishAt = input.publishAt || undefined; changes.publishAt = input.publishAt || null;
      }
      if (input.embeddable !== undefined) { status.embeddable = Boolean(input.embeddable); changes.embeddable = status.embeddable; }
      if (input.license !== undefined) { status.license = input.license; changes.license = input.license; }
      if (input.selfDeclaredMadeForKids !== undefined) { status.selfDeclaredMadeForKids = Boolean(input.selfDeclaredMadeForKids); changes.selfDeclaredMadeForKids = status.selfDeclaredMadeForKids; }
      if (input.containsSyntheticMedia !== undefined) { status.containsSyntheticMedia = Boolean(input.containsSyntheticMedia); changes.containsSyntheticMedia = status.containsSyntheticMedia; }
      if (!Object.keys(changes).length) throw new YouTubeError('No video fields supplied', { status: 400 });
      // snippet.categoryId and title are required by videos.update.
      if (!snippet.categoryId) snippet.categoryId = '22';
      delete snippet.thumbnails; delete snippet.localized; delete snippet.liveBroadcastContent; delete snippet.publishedAt; delete snippet.channelId; delete snippet.channelTitle;
      await youtube.videos.update({ part: ['snippet', 'status'], requestBody: { id: videoId, snippet, status } });
      return { changes, video: await this.getVideo(videoId) };
    });
  }

  setThumbnail(videoId, buffer, mimeType) {
    return this.call('Set video thumbnail', async ({ youtube }) => {
      if (!buffer?.length) throw new YouTubeError('Thumbnail body is empty', { status: 400 });
      if (buffer.length > 2 * 1024 * 1024) throw new YouTubeError('Thumbnail must be 2 MB or less', { status: 400 });
      const response = await youtube.thumbnails.set({ videoId, media: { mimeType: mimeType || 'image/png', body: Readable.from(buffer) } });
      return { videoId, thumbnails: response.data.items?.[0] || null, note: 'Custom thumbnails require a verified (phone) YouTube account.' };
    });
  }

  deleteVideo(videoId) {
    return this.call('Delete video', async ({ youtube }) => { await youtube.videos.delete({ id: videoId }); return { deleted: videoId }; });
  }

  listCategories(regionCode = 'US') {
    return this.call('List video categories', async ({ youtube }) => {
      const response = await youtube.videoCategories.list({ part: ['snippet'], regionCode });
      return (response.data.items || []).filter(c => c.snippet?.assignable).map(c => ({ id: c.id, title: c.snippet.title }));
    });
  }

  // --------------------------------------------------------------- captions
  listCaptions(videoId) {
    return this.call('List captions', async ({ youtube }) => {
      const response = await youtube.captions.list({ part: ['snippet'], videoId });
      return (response.data.items || []).map(c => ({ id: c.id, language: c.snippet.language, name: c.snippet.name, kind: c.snippet.trackKind, isDraft: c.snippet.isDraft, status: c.snippet.status, lastUpdated: c.snippet.lastUpdated }));
    });
  }

  uploadCaption(videoId, buffer, { language = 'en', name = '', mimeType = 'application/octet-stream', isDraft = false } = {}) {
    return this.call('Upload caption track', async ({ youtube }) => {
      if (!buffer?.length) throw new YouTubeError('Caption body is empty', { status: 400 });
      const response = await youtube.captions.insert({
        part: ['snippet'],
        requestBody: { snippet: { videoId, language, name, isDraft } },
        media: { mimeType, body: Readable.from(buffer) }
      });
      return { id: response.data.id, language, name, isDraft };
    });
  }

  deleteCaption(captionId) {
    return this.call('Delete caption track', async ({ youtube }) => { await youtube.captions.delete({ id: captionId }); return { deleted: captionId }; });
  }

  // -------------------------------------------------------------- playlists
  summarizePlaylist(p) {
    return { id: p.id, title: p.snippet?.title, description: p.snippet?.description || '', privacyStatus: p.status?.privacyStatus, itemCount: p.contentDetails?.itemCount ?? null, publishedAt: p.snippet?.publishedAt, url: `https://www.youtube.com/playlist?list=${p.id}` };
  }

  listPlaylists({ maxResults = 50, pageToken } = {}) {
    return this.call('List playlists', async ({ youtube }) => {
      const response = await youtube.playlists.list({ part: ['snippet', 'status', 'contentDetails'], mine: true, maxResults: Math.min(50, maxResults), pageToken });
      return { items: (response.data.items || []).map(p => this.summarizePlaylist(p)), nextPageToken: response.data.nextPageToken || null };
    });
  }

  createPlaylist({ title, description = '', privacyStatus = 'public', defaultLanguage } = {}) {
    return this.call('Create playlist', async ({ youtube }) => {
      if (!title || String(title).length > 150) throw new YouTubeError('title is required (max 150 characters)', { status: 400 });
      if (!VIDEO_PRIVACY.has(privacyStatus)) throw new YouTubeError('privacyStatus must be private, unlisted or public', { status: 400 });
      const response = await youtube.playlists.insert({ part: ['snippet', 'status'], requestBody: { snippet: { title, description, defaultLanguage }, status: { privacyStatus } } });
      return this.summarizePlaylist(response.data);
    });
  }

  updatePlaylist(playlistId, input = {}) {
    return this.call('Update playlist', async ({ youtube }) => {
      const current = (await youtube.playlists.list({ part: ['snippet', 'status'], id: [playlistId] })).data.items?.[0];
      if (!current) throw new YouTubeError(`Playlist ${playlistId} not found`, { status: 404 });
      const snippet = { title: input.title ?? current.snippet.title, description: input.description ?? current.snippet.description };
      const status = { privacyStatus: input.privacyStatus ?? current.status.privacyStatus };
      const response = await youtube.playlists.update({ part: ['snippet', 'status'], requestBody: { id: playlistId, snippet, status } });
      return this.summarizePlaylist(response.data);
    });
  }

  deletePlaylist(playlistId) {
    return this.call('Delete playlist', async ({ youtube }) => { await youtube.playlists.delete({ id: playlistId }); return { deleted: playlistId }; });
  }

  listPlaylistItems(playlistId, { maxResults = 50, pageToken } = {}) {
    return this.call('List playlist items', async ({ youtube }) => {
      const response = await youtube.playlistItems.list({ part: ['snippet', 'contentDetails', 'status'], playlistId, maxResults: Math.min(50, maxResults), pageToken });
      return {
        items: (response.data.items || []).map(i => ({ id: i.id, videoId: i.contentDetails?.videoId, title: i.snippet?.title, position: i.snippet?.position, privacyStatus: i.status?.privacyStatus, videoPublishedAt: i.contentDetails?.videoPublishedAt })),
        nextPageToken: response.data.nextPageToken || null
      };
    });
  }

  addToPlaylist(playlistId, videoId, position) {
    return this.call('Add video to playlist', async ({ youtube }) => {
      const snippet = { playlistId, resourceId: { kind: 'youtube#video', videoId } };
      if (position !== undefined) snippet.position = Number(position);
      const response = await youtube.playlistItems.insert({ part: ['snippet'], requestBody: { snippet } });
      return { id: response.data.id, playlistId, videoId, position: response.data.snippet?.position };
    });
  }

  removePlaylistItem(playlistItemId) {
    return this.call('Remove playlist item', async ({ youtube }) => { await youtube.playlistItems.delete({ id: playlistItemId }); return { deleted: playlistItemId }; });
  }

  // ---------------------------------------------------------------- sections
  listSections() {
    return this.call('List channel sections', async ({ youtube }) => {
      const response = await youtube.channelSections.list({ part: ['snippet', 'contentDetails'], mine: true });
      return (response.data.items || []).map(s => ({ id: s.id, type: s.snippet?.type, title: s.snippet?.title || null, position: s.snippet?.position, playlists: s.contentDetails?.playlists || [], channels: s.contentDetails?.channels || [] }));
    });
  }

  createSection({ type, title, playlists = [], channels = [], position } = {}) {
    return this.call('Create channel section', async ({ youtube }) => {
      if (!SECTION_TYPES.has(type)) throw new YouTubeError(`type must be one of ${[...SECTION_TYPES].join(', ')}`, { status: 400 });
      const snippet = { type };
      if (title) snippet.title = title;
      if (position !== undefined) snippet.position = Number(position);
      const contentDetails = {};
      if (playlists.length) contentDetails.playlists = playlists;
      if (channels.length) contentDetails.channels = channels;
      const response = await youtube.channelSections.insert({ part: ['snippet', 'contentDetails'], requestBody: { snippet, contentDetails } });
      return { id: response.data.id, type, title: title || null, position: response.data.snippet?.position };
    });
  }

  deleteSection(sectionId) {
    return this.call('Delete channel section', async ({ youtube }) => { await youtube.channelSections.delete({ id: sectionId }); return { deleted: sectionId }; });
  }

  // --------------------------------------------------------------- watermark
  setWatermark(buffer, mimeType, { offsetMs = 0, durationMs, corner = 'topRight' } = {}) {
    return this.call('Set channel watermark', async ({ youtube }) => {
      if (!buffer?.length) throw new YouTubeError('Watermark image body is empty', { status: 400 });
      const channelId = await this.channelId();
      const timing = durationMs ? { type: 'offsetFromStart', offsetMs: Number(offsetMs), durationMs: Number(durationMs) } : { type: 'offsetFromStart', offsetMs: Number(offsetMs) };
      await youtube.watermarks.set({ channelId, requestBody: { timing, position: { type: 'corner', cornerPosition: corner } }, media: { mimeType: mimeType || 'image/png', body: Readable.from(buffer) } });
      return { channelId, timing, corner };
    });
  }

  unsetWatermark() {
    return this.call('Remove channel watermark', async ({ youtube }) => { const channelId = await this.channelId(); await youtube.watermarks.unset({ channelId }); return { channelId, removed: true }; });
  }

  // ---------------------------------------------------------------- comments
  listComments(videoId, { maxResults = 50, order = 'time', pageToken, searchTerms } = {}) {
    return this.call('List comments', async ({ youtube }) => {
      const response = await youtube.commentThreads.list({ part: ['snippet', 'replies'], videoId, maxResults: Math.min(100, maxResults), order, pageToken, searchTerms, textFormat: 'plainText' });
      const thread = t => {
        const top = t.snippet?.topLevelComment?.snippet || {};
        return {
          threadId: t.id, commentId: t.snippet?.topLevelComment?.id, author: top.authorDisplayName, authorChannelId: top.authorChannelId?.value || null,
          text: top.textDisplay, likes: top.likeCount, publishedAt: top.publishedAt, updatedAt: top.updatedAt, moderationStatus: top.moderationStatus || null,
          totalReplies: t.snippet?.totalReplyCount || 0,
          replies: (t.replies?.comments || []).map(r => ({ commentId: r.id, author: r.snippet.authorDisplayName, text: r.snippet.textDisplay, publishedAt: r.snippet.publishedAt }))
        };
      };
      return { items: (response.data.items || []).map(thread), nextPageToken: response.data.nextPageToken || null };
    });
  }

  replyToComment(parentId, text) {
    return this.call('Reply to comment', async ({ youtube }) => {
      if (!text || String(text).length > 10000) throw new YouTubeError('text is required (max 10000 characters)', { status: 400 });
      const response = await youtube.comments.insert({ part: ['snippet'], requestBody: { snippet: { parentId, textOriginal: text } } });
      return { commentId: response.data.id, parentId, text: response.data.snippet?.textOriginal, publishedAt: response.data.snippet?.publishedAt };
    });
  }

  postComment(videoId, text) {
    return this.call('Post comment', async ({ youtube }) => {
      if (!text || String(text).length > 10000) throw new YouTubeError('text is required (max 10000 characters)', { status: 400 });
      const channelId = await this.channelId();
      const response = await youtube.commentThreads.insert({ part: ['snippet'], requestBody: { snippet: { channelId, videoId, topLevelComment: { snippet: { textOriginal: text } } } } });
      return { threadId: response.data.id, videoId, text };
    });
  }

  moderateComment(commentId, moderationStatus, banAuthor = false) {
    return this.call('Moderate comment', async ({ youtube }) => {
      if (!MODERATION.has(moderationStatus)) throw new YouTubeError('moderationStatus must be published, heldForReview or rejected', { status: 400 });
      await youtube.comments.setModerationStatus({ id: [commentId], moderationStatus, banAuthor: moderationStatus === 'rejected' && banAuthor === true });
      return { commentId, moderationStatus, banAuthor: moderationStatus === 'rejected' && banAuthor === true };
    });
  }

  // ------------------------------------------------------------------ search
  search({ q, type = 'video', order = 'relevance', maxResults = 10, regionCode, publishedAfter, channelId, videoDuration } = {}) {
    return this.call('Search YouTube', async ({ youtube }) => {
      if (!q && !channelId) throw new YouTubeError('q (query) or channelId is required', { status: 400 });
      const params = { part: ['snippet'], q, type: [type], order, maxResults: Math.min(50, maxResults), regionCode, publishedAfter, channelId };
      if (type === 'video' && videoDuration) params.videoDuration = videoDuration;
      const response = await youtube.search.list(params);
      const items = (response.data.items || []).map(item => ({
        kind: item.id?.kind?.replace('youtube#', ''), id: item.id?.videoId || item.id?.channelId || item.id?.playlistId,
        title: item.snippet?.title, channelTitle: item.snippet?.channelTitle, channelId: item.snippet?.channelId,
        publishedAt: item.snippet?.publishedAt, description: item.snippet?.description
      }));
      if (type === 'video' && items.length) {
        const stats = await youtube.videos.list({ part: ['statistics', 'contentDetails'], id: items.map(i => i.id) });
        const byId = new Map((stats.data.items || []).map(v => [v.id, v]));
        for (const item of items) {
          const v = byId.get(item.id);
          if (v) { item.views = Number(v.statistics?.viewCount ?? 0); item.likes = Number(v.statistics?.likeCount ?? 0); item.duration = v.contentDetails?.duration; }
        }
      }
      return { items, nextPageToken: response.data.nextPageToken || null, quotaNote: 'search.list costs 100 quota units per call' };
    });
  }

  // --------------------------------------------------------------- analytics
  analyticsQuery({ startDate, endDate, metrics, dimensions, filters, sort, maxResults } = {}) {
    return this.call('YouTube Analytics query', async ({ analytics }) => {
      if (!startDate || !endDate) throw new YouTubeError('startDate and endDate (YYYY-MM-DD) are required', { status: 400 });
      const response = await analytics.reports.query({
        ids: 'channel==MINE', startDate, endDate,
        metrics: arr(metrics).join(',') || 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost',
        dimensions: arr(dimensions).join(',') || undefined, filters: filters || undefined, sort: sort || undefined, maxResults: num(maxResults)
      });
      const headers = (response.data.columnHeaders || []).map(h => h.name);
      const rows = (response.data.rows || []).map(row => Object.fromEntries(row.map((value, i) => [headers[i], value])));
      return { headers, rows, rowCount: rows.length };
    });
  }
}

module.exports = { YouTubeChannelService, YouTubeError };
