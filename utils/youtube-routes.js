const express = require('express');

// REST surface for direct YouTube channel management (see
// youtube-channel-service.js). Mounted under /api/youtube. Reads are open like
// the rest of the dashboard API; every write requires the API key.
function registerYouTubeRoutes(app, protect, getService) {
  const run = (handler, okStatus = 200) => async (req, res) => {
    try {
      const service = getService();
      if (!service) return res.status(503).json({ success: false, error: 'YouTube is not connected; finish the walkthrough first' });
      const result = await handler(service, req);
      return res.status(okStatus).json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message, reason: error.reason, details: error.details });
    }
  };
  const image = express.raw({ type: ['image/*'], limit: '10mb' });
  const text = express.raw({ type: ['text/*', 'application/x-subrip', 'application/octet-stream'], limit: '2mb' });
  const mime = req => req.get('content-type')?.split(';')[0]?.trim();
  const body = req => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  const int = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' && value !== undefined ? Number(value) : fallback);

  // channel
  app.get('/api/youtube/channel', run(s => s.getChannel()));
  app.put('/api/youtube/channel/branding', protect, run((s, req) => s.updateBranding(req.body || {})));
  app.put('/api/youtube/channel/banner', protect, image, run((s, req) => s.setBanner(body(req), mime(req))));
  app.put('/api/youtube/channel/watermark', protect, image, run((s, req) => s.setWatermark(body(req), mime(req), { offsetMs: int(req.query.offsetMs, 0), durationMs: int(req.query.durationMs, undefined), corner: req.query.corner || 'topRight' })));
  app.delete('/api/youtube/channel/watermark', protect, run(s => s.unsetWatermark()));
  app.get('/api/youtube/channel/sections', run(s => s.listSections()));
  app.post('/api/youtube/channel/sections', protect, run((s, req) => s.createSection(req.body || {}), 201));
  app.delete('/api/youtube/channel/sections/:sectionId', protect, run((s, req) => s.deleteSection(req.params.sectionId)));

  // videos
  app.get('/api/youtube/videos', run((s, req) => s.listVideos({ maxResults: int(req.query.maxResults, 25), pageToken: req.query.pageToken })));
  app.get('/api/youtube/categories', run((s, req) => s.listCategories(req.query.regionCode || 'US')));
  app.get('/api/youtube/videos/:videoId', run((s, req) => s.getVideo(req.params.videoId)));
  app.patch('/api/youtube/videos/:videoId', protect, run((s, req) => s.updateVideo(req.params.videoId, req.body || {})));
  app.delete('/api/youtube/videos/:videoId', protect, run((s, req) => s.deleteVideo(req.params.videoId)));
  app.put('/api/youtube/videos/:videoId/thumbnail', protect, image, run((s, req) => s.setThumbnail(req.params.videoId, body(req), mime(req))));
  app.get('/api/youtube/videos/:videoId/captions', run((s, req) => s.listCaptions(req.params.videoId)));
  app.put('/api/youtube/videos/:videoId/captions', protect, text, run((s, req) => s.uploadCaption(req.params.videoId, body(req), { language: req.query.language || 'en', name: req.query.name || '', isDraft: req.query.isDraft === 'true', mimeType: mime(req) || 'application/octet-stream' }), 201));
  app.delete('/api/youtube/captions/:captionId', protect, run((s, req) => s.deleteCaption(req.params.captionId)));
  app.get('/api/youtube/videos/:videoId/comments', run((s, req) => s.listComments(req.params.videoId, { maxResults: int(req.query.maxResults, 50), order: req.query.order || 'time', pageToken: req.query.pageToken, searchTerms: req.query.searchTerms })));
  app.post('/api/youtube/videos/:videoId/comments', protect, run((s, req) => s.postComment(req.params.videoId, req.body?.text), 201));
  app.post('/api/youtube/comments/:commentId/reply', protect, run((s, req) => s.replyToComment(req.params.commentId, req.body?.text), 201));
  app.post('/api/youtube/comments/:commentId/moderate', protect, run((s, req) => s.moderateComment(req.params.commentId, req.body?.moderationStatus, req.body?.banAuthor === true)));

  // playlists
  app.get('/api/youtube/playlists', run((s, req) => s.listPlaylists({ maxResults: int(req.query.maxResults, 50), pageToken: req.query.pageToken })));
  app.post('/api/youtube/playlists', protect, run((s, req) => s.createPlaylist(req.body || {}), 201));
  app.patch('/api/youtube/playlists/:playlistId', protect, run((s, req) => s.updatePlaylist(req.params.playlistId, req.body || {})));
  app.delete('/api/youtube/playlists/:playlistId', protect, run((s, req) => s.deletePlaylist(req.params.playlistId)));
  app.get('/api/youtube/playlists/:playlistId/items', run((s, req) => s.listPlaylistItems(req.params.playlistId, { maxResults: int(req.query.maxResults, 50), pageToken: req.query.pageToken })));
  app.post('/api/youtube/playlists/:playlistId/items', protect, run((s, req) => s.addToPlaylist(req.params.playlistId, req.body?.videoId, req.body?.position), 201));
  app.delete('/api/youtube/playlist-items/:itemId', protect, run((s, req) => s.removePlaylistItem(req.params.itemId)));

  // research & analytics (reads)
  app.get('/api/youtube/search', run((s, req) => s.search({ q: req.query.q, type: req.query.type || 'video', order: req.query.order || 'relevance', maxResults: int(req.query.maxResults, 10), regionCode: req.query.regionCode, publishedAfter: req.query.publishedAfter, channelId: req.query.channelId, videoDuration: req.query.videoDuration })));
  app.get('/api/youtube/analytics', run((s, req) => s.analyticsQuery({ startDate: req.query.startDate, endDate: req.query.endDate, metrics: req.query.metrics, dimensions: req.query.dimensions, filters: req.query.filters, sort: req.query.sort, maxResults: req.query.maxResults })));
}

module.exports = { registerYouTubeRoutes };
