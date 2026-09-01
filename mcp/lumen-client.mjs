// Thin HTTP client for a running Lumen / AgentTube instance.
//
// The MCP server never touches the database or the agents directly: every
// action goes through the same REST API the dashboard uses, so approval
// gates, cost confirmations and fail-closed publishing rules stay in force.

export class LumenError extends Error {
  constructor(message, { status, code, details, path } = {}) {
    super(message);
    this.name = 'LumenError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.path = path;
  }
}

export class LumenClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl      e.g. https://lumen.example.com or http://localhost:3456
   * @param {string} [options.apiKey]     Lumen API_KEY (sent as x-api-key on mutating routes)
   * @param {string} [options.basicAuth]  "user:password" when the instance sits behind HTTP basic auth
   * @param {number} [options.timeoutMs]  default per-request timeout
   */
  constructor({ baseUrl, apiKey, basicAuth, timeoutMs = 120_000, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) throw new Error('LUMEN_URL is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.basicAuth = basicAuth || '';
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  headers(hasBody) {
    const headers = { Accept: 'application/json' };
    if (hasBody) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (this.basicAuth) headers.Authorization = `Basic ${Buffer.from(this.basicAuth).toString('base64')}`;
    return headers;
  }

  async request(method, path, { body, query, timeoutMs } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') {
        throw new LumenError(`Request timed out after ${(timeoutMs || this.timeoutMs) / 1000}s: ${method} ${path}. The server keeps working; check the job or production again in a moment.`, { status: 504, path });
      }
      throw new LumenError(`Could not reach Lumen at ${this.baseUrl}: ${error.message}`, { status: 0, path });
    }
    clearTimeout(timer);

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: raw.slice(0, 400) };
    }

    if (!response.ok) {
      const message = data.error || data.message || `${response.status} ${response.statusText}`;
      const hint = response.status === 401
        ? ' (401: check LUMEN_API_KEY and LUMEN_BASIC_AUTH)'
        : response.status === 409 ? ' (409: a gate or state check refused this action)' : '';
      throw new LumenError(`${message}${hint}`, {
        status: response.status,
        code: data.code,
        details: data.details || data.blockers || data.quality,
        path
      });
    }
    // Most routes wrap payloads as { success, result }; unwrap for callers.
    if (data && typeof data === 'object' && 'success' in data && 'result' in data) return data.result;
    if (data && typeof data === 'object' && data.success === false) {
      throw new LumenError(data.error || 'Request failed', { status: response.status, code: data.code, details: data.details, path });
    }
    return data;
  }

  /** Send raw bytes (image, caption file) with an explicit content type. */
  async upload(method, path, buffer, contentType, query, { timeoutMs } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = this.headers(false);
    headers['Content-Type'] = contentType;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    let response;
    try {
      response = await this.fetch(url, { method, headers, body: buffer, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      throw new LumenError(`Upload failed: ${error.name === 'AbortError' ? 'timed out' : error.message}`, { status: error.name === 'AbortError' ? 504 : 0, path });
    }
    clearTimeout(timer);
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw.slice(0, 400) }; }
    if (!response.ok || data.success === false) {
      throw new LumenError(data.error || `${response.status} ${response.statusText}`, { status: response.status, code: data.code || data.reason, details: data.details, path });
    }
    return 'result' in data ? data.result : data;
  }

  get(path, query, options) { return this.request('GET', path, { query, ...options }); }
  post(path, body = {}, options) { return this.request('POST', path, { body, ...options }); }
  put(path, body = {}, options) { return this.request('PUT', path, { body, ...options }); }
  patch(path, body = {}, options) { return this.request('PATCH', path, { body, ...options }); }

  // ---- status ---------------------------------------------------------
  health() { return this.get('/health'); }
  dashboard() { return this.get('/api/dashboard'); }
  schedule() { return this.get('/schedule'); }
  analytics() { return this.get('/analytics'); }
  outcomes() { return this.get('/api/outcomes'); }

  // ---- generation jobs ------------------------------------------------
  generate({ topic, style, length, strategyContext }) {
    return this.post('/generate', { topic: topic ?? null, style: style ?? null, length, strategyContext: strategyContext ?? null });
  }
  job(jobId) { return this.get(`/api/jobs/${encodeURIComponent(jobId)}`); }
  resumeJob(jobId, stage) { return this.post(`/api/jobs/${encodeURIComponent(jobId)}/resume`, stage ? { stage } : {}); }
  cancelJob(jobId, reason) { return this.post(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, reason ? { reason } : {}); }

  // ---- readiness ------------------------------------------------------
  readiness() { return this.get('/api/readiness'); }
  runReadiness({ includePaidMedia = false, includePaidVideo = false } = {}) {
    return this.post('/api/readiness/run', { includePaidMedia, includePaidVideo }, { timeoutMs: 600_000 });
  }

  // ---- productions / review ------------------------------------------
  production(productionId) { return this.get(`/api/content/${encodeURIComponent(productionId)}`); }
  editMetadata(productionId, editor) { return this.patch(`/api/content/${encodeURIComponent(productionId)}`, editor); }
  approve(productionId, input) { return this.post(`/api/content/${encodeURIComponent(productionId)}/approve`, input); }
  unschedule(productionId, reason) { return this.post(`/api/content/${encodeURIComponent(productionId)}/unschedule`, reason ? { reason } : {}); }
  reject(productionId, notes) { return this.post(`/api/content/${encodeURIComponent(productionId)}/reject`, notes ? { notes } : {}); }
  retry(productionId) { return this.post(`/api/content/${encodeURIComponent(productionId)}/retry`); }
  reviewProvenance(productionId, input) { return this.put(`/api/content/${encodeURIComponent(productionId)}/provenance`, input); }
  runDiscoverability(productionId, platform) {
    return this.post(`/api/content/${encodeURIComponent(productionId)}/discoverability/run`, platform ? { platform } : {}, { timeoutMs: 180_000 });
  }
  reviewFinding(findingId, input) { return this.patch(`/api/discoverability/findings/${encodeURIComponent(findingId)}`, input); }

  // ---- scenes ---------------------------------------------------------
  updateScene(productionId, sceneId, input) {
    return this.patch(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}`, input);
  }
  reorderScenes(productionId, sceneIds) { return this.post(`/api/content/${encodeURIComponent(productionId)}/scenes/reorder`, { sceneIds }); }
  sceneEstimate(productionId, sceneId, provider) {
    return this.get(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/estimate`, provider ? { provider } : undefined);
  }
  regenerateScene(productionId, sceneId, input) {
    return this.post(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/regenerate`, input, { timeoutMs: 900_000 });
  }
  regenerateNarration(productionId, sceneId, input) {
    return this.post(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/narration`, input, { timeoutMs: 300_000 });
  }
  silenceOverride(productionId, input) { return this.post(`/api/content/${encodeURIComponent(productionId)}/narration/silence`, input); }
  rebuild(productionId) { return this.post(`/api/content/${encodeURIComponent(productionId)}/scenes/rebuild`, {}, { timeoutMs: 1_500_000 }); }

  // ---- shorts ---------------------------------------------------------
  proposeShorts(productionId, input) { return this.post(`/api/content/${encodeURIComponent(productionId)}/shorts/propose`, input); }
  updateShort(productionId, clipId, input) { return this.patch(`/api/content/${encodeURIComponent(productionId)}/shorts/${encodeURIComponent(clipId)}`, input); }
  renderShort(productionId, clipId) { return this.post(`/api/content/${encodeURIComponent(productionId)}/shorts/${encodeURIComponent(clipId)}/render`, {}, { timeoutMs: 900_000 }); }
  approveShort(productionId, clipId, input) { return this.post(`/api/content/${encodeURIComponent(productionId)}/shorts/${encodeURIComponent(clipId)}/approve`, input); }

  // ---- channel profile / strategy / operator --------------------------
  updateProfile(profile) { return this.put('/api/profile', profile); }
  saveStrategy(strategy) { return this.put('/api/operator/strategy', strategy); }
  startOperator(strategy) { return this.post('/api/operator/start', strategy || {}); }
  pauseOperator() { return this.post('/api/operator/pause'); }
  cancelOperatorRun(runId) { return this.post(`/api/operator/runs/${encodeURIComponent(runId)}/cancel`); }
  resumeOperatorRun(runId) { return this.post(`/api/operator/runs/${encodeURIComponent(runId)}/resume`); }
  reviewLearning(recommendationId, action) { return this.post(`/api/learning/recommendations/${encodeURIComponent(recommendationId)}/${action}`); }

  // ---- experiments / retention / engagement --------------------------
  experiments() { return this.get('/api/experiments'); }
  createExperiment(input) { return this.post('/api/experiments', input); }
  experimentAction(experimentId, action, input) { return this.post(`/api/experiments/${encodeURIComponent(experimentId)}/${action}`, input || {}); }
  retention(videoId) { return this.get(`/api/retention/${encodeURIComponent(videoId)}`); }
  refreshRetention(videoId, measurementWindow) { return this.post(`/api/retention/${encodeURIComponent(videoId)}/refresh`, measurementWindow ? { measurementWindow } : {}, { timeoutMs: 180_000 }); }
  engagement(videoId) { return this.get(`/api/engagement/${encodeURIComponent(videoId)}`); }
  syncEngagement(videoId, analyze) { return this.post(`/api/engagement/${encodeURIComponent(videoId)}/sync`, { analyze }, { timeoutMs: 300_000 }); }
  draftReplies(videoId, input) { return this.post(`/api/engagement/${encodeURIComponent(videoId)}/draft-replies`, input || {}, { timeoutMs: 300_000 }); }
  updateReplyDraft(draftId, input) { return this.patch(`/api/engagement/replies/${encodeURIComponent(draftId)}`, input); }
  approveReply(draftId, input) { return this.post(`/api/engagement/replies/${encodeURIComponent(draftId)}/approve`, input); }

  // ---- ideas / automation / settings / notifications -----------------
  createIdea(input) { return this.post('/api/ideas', input); }
  updateIdea(ideaId, input) { return this.patch(`/api/ideas/${encodeURIComponent(ideaId)}`, input); }
  generateIdea(ideaId, length) { return this.post(`/api/ideas/${encodeURIComponent(ideaId)}/generate`, length ? { length } : {}); }
  automation(action) { return this.post(`/api/automation/${action}`); }
  updateSettings(settings) { return this.put('/api/settings', settings); }
  markNotificationRead(notificationId) { return this.post(`/api/notifications/${encodeURIComponent(notificationId)}/read`); }
}
