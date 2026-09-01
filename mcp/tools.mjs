// Tool definitions for the Lumen MCP server.
//
// Conventions
// - Read tools carry readOnlyHint. Anything that spends provider credits,
//   uploads, or is otherwise hard to undo requires `confirm: true` and says
//   so in its description, so the calling agent must state the decision.
// - Results are JSON text. Large bundles are summarised by default; ask for
//   `detail: "full"` when the whole record is needed.
import { z } from 'zod';
import { LumenError } from './lumen-client.mjs';

const STYLES = ['tutorial', 'explainer', 'list', 'review', 'story'];
const LENGTHS = ['short', 'medium', 'long'];
const PRIVACY = ['private', 'unlisted', 'public'];
const STAGES = ['strategy', 'script', 'thumbnail', 'seo', 'production'];

const readOnly = { readOnlyHint: true, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(error) {
  const payload = error instanceof LumenError
    ? { error: error.message, status: error.status, code: error.code, details: error.details, path: error.path }
    : { error: error.message };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function requireConfirm(confirm, what) {
  if (confirm !== true) {
    throw new LumenError(`Refused: ${what} requires confirm=true. State the decision (and any cost) to the operator, then call again with confirm=true.`, { status: 412, code: 'CONFIRM_REQUIRED' });
  }
}

const fileName = value => (typeof value === 'string' ? value.split('/').pop() : value ?? null);

export function summarizeJob(job) {
  if (!job) return job;
  return {
    id: job.id, status: job.status, stage: job.stage, progress: job.progress,
    topic: job.topic, style: job.style, length: job.length, source: job.source,
    productionId: job.production_id ?? job.productionId ?? null, title: job.title ?? null,
    error: job.error ?? null, createdAt: job.created_at ?? job.createdAt, updatedAt: job.updated_at ?? job.updatedAt,
    completedAt: job.completed_at ?? job.completedAt ?? null,
    checkpoints: Array.isArray(job.checkpoints) ? job.checkpoints.map(c => ({ stage: c.stage, status: c.status })) : undefined
  };
}

export function summarizeScene(scene) {
  return {
    id: scene.id, position: scene.position, label: scene.label, duration: scene.duration,
    status: scene.status, narrationStatus: scene.narrationStatus, revision: scene.revision, locked: scene.locked,
    assetType: scene.assetType, assetOrigin: scene.assetOrigin, asset: fileName(scene.assetPath),
    audio: fileName(scene.audioPath), provider: scene.provider, rightsConfirmed: scene.rightsConfirmed,
    scriptText: scene.scriptText, prompt: scene.prompt
  };
}

export function summarizeProduction(bundle) {
  if (!bundle) return bundle;
  const assets = bundle.assets || {};
  const provenance = bundle.provenance || {};
  const claims = provenance.claims || [];
  const quality = bundle.qualityChecks || bundle.quality_checks || [];
  const scenes = bundle.scenes || [];
  return {
    id: bundle.id,
    title: bundle.seo?.title || bundle.script?.title,
    status: bundle.status,
    reviewStatus: bundle.review_status ?? bundle.reviewStatus,
    reviewNotes: bundle.review_notes ?? bundle.reviewNotes ?? null,
    scheduledPublishTime: bundle.scheduled_publish_time ?? bundle.scheduledPublishTime ?? null,
    schedule: bundle.schedule ? { status: bundle.schedule.status, publishTime: bundle.schedule.publishTime ?? bundle.schedule.publish_time, videoId: bundle.schedule.videoId ?? bundle.schedule.video_id ?? null } : null,
    blockingFailures: quality.filter(q => q.blocking && !q.passed).map(q => ({ id: q.id, message: q.message })),
    advisoryFailures: quality.filter(q => !q.blocking && !q.passed).map(q => ({ id: q.id, message: q.message })),
    editor: {
      title: bundle.editorData?.title, description: bundle.editorData?.description?.slice(0, 300),
      tags: bundle.editorData?.tags, privacyStatus: bundle.editorData?.privacyStatus, publishTime: bundle.editorData?.publishTime,
      factChecked: bundle.editorData?.factChecked ?? false, rightsConfirmed: bundle.editorData?.rightsConfirmed ?? false
    },
    provenance: {
      status: provenance.status, containsSyntheticMedia: provenance.containsSyntheticMedia === true,
      sources: (provenance.sources || []).map(s => ({ id: s.id, url: s.url, status: s.status })),
      claims: claims.map(c => ({ id: c.id, status: c.status, riskLevel: c.riskLevel, text: c.text, sourceIds: c.sourceIds, notes: c.notes || undefined }))
    },
    discoverability: bundle.discoverability ? {
      status: bundle.discoverability.status, engineVersion: bundle.discoverability.engineVersion,
      severity: bundle.discoverability.summary?.severity, error: bundle.discoverability.error || null,
      findings: (bundle.discoverability.findings || []).map(f => ({ id: f.id, ruleId: f.ruleId, severity: f.severity, title: f.title || f.message, decision: f.decision || f.state || null }))
    } : null,
    assets: {
      finalVideo: assets.finalVideo ? { file: fileName(assets.finalVideo.path), duration: assets.finalVideo.duration, simulated: assets.finalVideo.simulated === true } : null,
      audio: assets.audio ? { file: fileName(assets.audio.path), status: assets.audio.status, provider: assets.audio.provider, duration: assets.audio.duration } : null,
      thumbnail: fileName(assets.thumbnail?.path), captions: fileName(assets.captions?.path)
    },
    assetUrls: bundle.assetUrls,
    scenes: { count: scenes.length, totalDuration: Number(scenes.reduce((sum, s) => sum + Number(s.duration || 0), 0).toFixed(2)),
      needingAttention: scenes.filter(s => s.status !== 'ready' || !['current', 'intentional_silence'].includes(s.narrationStatus)).map(s => ({ id: s.id, label: s.label, status: s.status, narrationStatus: s.narrationStatus })) },
    shorts: (bundle.shorts || []).map(c => ({ id: c.id, status: c.status, title: c.title, layout: c.layout, duration: c.duration })),
    strategy: bundle.strategy ? { topic: bundle.strategy.topic, angle: bundle.strategy.angle, contentType: bundle.strategy.contentType, targetAudience: bundle.strategy.targetAudience } : null,
    createdAt: bundle.created_at ?? bundle.createdAt
  };
}

function summarizeDashboard(d) {
  const pipeline = Array.isArray(d.pipeline) ? d.pipeline : [];
  const byStatus = {};
  for (const item of pipeline) {
    const key = item.review_status || item.reviewStatus || item.status || 'unknown';
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  return {
    uptimeSeconds: d.uptime, agents: d.agents, autonomousRunning: d.autonomousRunning,
    stats: d.stats,
    automationPaused: d.settings?.automation_paused === 'true',
    readiness: d.readiness ? { status: d.readiness.status, checkedAt: d.readiness.checkedAt ?? d.readiness.createdAt, blocking: d.readiness.blocking } : null,
    jobs: (d.jobs || []).slice(0, 10).map(summarizeJob),
    pipelineByStatus: byStatus,
    pipeline: pipeline.slice(0, 25).map(p => ({ id: p.id, title: p.title || p.seo?.title || p.script?.title, status: p.status, reviewStatus: p.review_status ?? p.reviewStatus, publishTime: p.scheduled_publish_time ?? p.scheduledPublishTime, createdAt: p.created_at ?? p.createdAt })),
    schedule: (d.schedule || []).slice(0, 10),
    notifications: (d.notifications || []).filter(n => !n.read && !n.read_at).slice(0, 10).map(n => ({ id: n.id, level: n.level, title: n.title, message: n.message, createdAt: n.created_at ?? n.createdAt })),
    profile: d.profile ? { channelName: d.profile.channel_name ?? d.profile.channelName, defaultStyle: d.profile.default_style ?? d.profile.defaultStyle, targetAudience: d.profile.target_audience ?? d.profile.targetAudience } : null,
    channelStrategy: d.channelStrategy ? { status: d.channelStrategy.status, objective: d.channelStrategy.objective, cadencePerWeek: d.channelStrategy.cadencePerWeek, primaryKpi: d.channelStrategy.primaryKpi } : null,
    operatorRuns: (d.operatorRuns || []).slice(0, 5).map(r => ({ id: r.id, status: r.status, stage: r.stage, createdAt: r.created_at ?? r.createdAt })),
    ideas: (d.ideas || []).slice(0, 15).map(i => ({ id: i.id, topic: i.topic, style: i.style, status: i.status })),
    learning: d.learning ? { pending: (d.learning.recommendations || d.learning.pending || []).filter(r => (r.status || 'pending') === 'pending').slice(0, 10).map(r => ({ id: r.id, title: r.title || r.summary, confidence: r.confidence })) } : null,
    events: (d.events || []).slice(0, 10).map(e => ({ type: e.type ?? e.event_type, message: e.message, at: e.created_at ?? e.createdAt }))
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function registerTools(server, client) {
  const tool = (name, config, handler) => server.registerTool(name, config, async (args, extra) => {
    try {
      return await handler(args || {}, extra);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ status
  tool('get_status', {
    title: 'Lumen status',
    description: 'Health plus a compact dashboard: capabilities, automation state, latest readiness result, recent jobs, pipeline counts, unread notifications, channel profile and strategy. Start here.',
    inputSchema: {}, annotations: readOnly
  }, async () => {
    const [health, dashboard] = await Promise.all([client.health(), client.dashboard()]);
    return json({ health, ...summarizeDashboard(dashboard) });
  });

  tool('get_dashboard_section', {
    title: 'Dashboard section (raw)',
    description: 'Return one raw section of the dashboard payload when the summary is not enough: stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation, channelStrategy, operatorRuns, readiness, engagement, experiments.',
    inputSchema: { section: z.string().describe('Section key, e.g. "pipeline" or "learning"') }, annotations: readOnly
  }, async ({ section }) => {
    const dashboard = await client.dashboard();
    if (!(section in dashboard)) return json({ error: `Unknown section "${section}"`, available: Object.keys(dashboard) });
    return json(dashboard[section]);
  });

  tool('get_schedule', { title: 'Upcoming schedule', description: 'Upcoming scheduled uploads (approved content waiting for its publish time).', inputSchema: {}, annotations: readOnly },
    async () => json(await client.schedule()));

  tool('get_analytics', { title: 'Analytics', description: 'Channel analytics summary, recent performance and learning recommendations.', inputSchema: {}, annotations: readOnly },
    async () => json(await client.analytics()));

  tool('get_outcomes', { title: 'Outcome & ROI', description: 'Goal-aligned outcome/ROI summary: KPI progress, evidence coverage, subscribers, revenue, known cost.', inputSchema: {}, annotations: readOnly },
    async () => json(await client.outcomes()));

  tool('mark_notification_read', { title: 'Mark notification read', description: 'Mark one dashboard notification as read.', inputSchema: { notificationId: z.string() }, annotations: mutating },
    async ({ notificationId }) => json(await client.markNotificationRead(notificationId)));

  // ------------------------------------------------------ generation jobs
  tool('generate_video', {
    title: 'Generate a video',
    description: 'Queue a full production (strategy → script → thumbnail → SEO → images + narration + render). COSTS MONEY: roughly one image per script section (gpt-image-2 ≈ $0.2 each) plus TTS and text — expect $1–3 and 15–25 minutes. Requires confirm=true. Returns the job; follow with wait_for_job.',
    inputSchema: {
      topic: z.string().max(200).optional().describe('Video topic. Omit to let the strategy agent pick a trending topic.'),
      style: z.enum(STYLES).optional(),
      length: z.enum(LENGTHS).default('medium'),
      confirm: z.boolean().describe('Must be true — this spends provider credits.')
    }, annotations: mutating
  }, async ({ topic, style, length, confirm }) => {
    requireConfirm(confirm, 'generate_video (spends image/TTS/text credits)');
    return json(summarizeJob(await client.generate({ topic, style, length })));
  });

  tool('get_job', { title: 'Get job', description: 'Status, stage, progress, error and saved checkpoints of a generation job.', inputSchema: { jobId: z.string() }, annotations: readOnly },
    async ({ jobId }) => json(summarizeJob(await client.job(jobId))));

  tool('wait_for_job', {
    title: 'Wait for job',
    description: 'Poll a generation job until it completes, fails, is cancelled or interrupted, or until timeoutSeconds elapses (default 480, max 540). Returns the latest state; call again if still running.',
    inputSchema: { jobId: z.string(), timeoutSeconds: z.number().int().min(10).max(540).default(480), pollSeconds: z.number().int().min(5).max(60).default(15) }, annotations: readOnly
  }, async ({ jobId, timeoutSeconds, pollSeconds }) => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const transitions = [];
    let last = null;
    while (Date.now() < deadline) {
      const job = summarizeJob(await client.job(jobId));
      const key = `${job.status}/${job.stage}/${job.progress}`;
      if (key !== last) { transitions.push({ at: new Date().toISOString(), status: job.status, stage: job.stage, progress: job.progress }); last = key; }
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return json({ done: true, job, transitions });
      await sleep(pollSeconds * 1000);
    }
    return json({ done: false, note: 'Still running; call wait_for_job again.', job: summarizeJob(await client.job(jobId)), transitions });
  });

  tool('resume_job', {
    title: 'Resume job',
    description: 'Resume a failed or interrupted job from its first incomplete checkpoint, or from an explicit stage to intentionally regenerate that stage and everything after it (production stage re-spends image/TTS credits).',
    inputSchema: { jobId: z.string(), stage: z.enum(STAGES).optional().describe('Omit to resume from the first incomplete stage.') }, annotations: mutating
  }, async ({ jobId, stage }) => json(summarizeJob(await client.resumeJob(jobId, stage))));

  tool('cancel_job', { title: 'Cancel job', description: 'Request cancellation of a running job (takes effect at the next stage boundary).', inputSchema: { jobId: z.string(), reason: z.string().max(200).optional() }, annotations: destructive },
    async ({ jobId, reason }) => json(await client.cancelJob(jobId, reason)));

  // ------------------------------------------------------------ readiness
  tool('get_readiness', { title: 'Readiness summary', description: 'Latest production-readiness result (text, images, video provider, narration, FFmpeg, YouTube access, metadata rules).', inputSchema: {}, annotations: readOnly },
    async () => json(await client.readiness()));

  tool('run_readiness_check', {
    title: 'Run readiness check',
    description: 'Run the verified readiness gate: tiny live text and narration calls, YouTube channel access, a throwaway MP4. Never uploads. includePaidMedia adds one paid image probe; includePaidVideo adds one paid video-provider clip — both need confirm=true.',
    inputSchema: { includePaidMedia: z.boolean().default(false), includePaidVideo: z.boolean().default(false), confirm: z.boolean().optional() }, annotations: mutating
  }, async ({ includePaidMedia, includePaidVideo, confirm }) => {
    if (includePaidMedia || includePaidVideo) requireConfirm(confirm, 'a readiness run with paid probes');
    return json(await client.runReadiness({ includePaidMedia, includePaidVideo }));
  });

  // --------------------------------------------------------- productions
  tool('list_productions', {
    title: 'List productions',
    description: 'Productions in the pipeline with review status. Filter by reviewStatus (needs_review, needs_attention, approved, rejected, …) to find what needs a human.',
    inputSchema: { reviewStatus: z.string().optional(), limit: z.number().int().min(1).max(100).default(25) }, annotations: readOnly
  }, async ({ reviewStatus, limit }) => {
    const dashboard = await client.dashboard();
    let items = Array.isArray(dashboard.pipeline) ? dashboard.pipeline : [];
    if (reviewStatus) items = items.filter(p => (p.review_status ?? p.reviewStatus) === reviewStatus);
    return json(items.slice(0, limit).map(p => ({ id: p.id, title: p.title || p.seo?.title || p.script?.title, status: p.status, reviewStatus: p.review_status ?? p.reviewStatus, reviewNotes: p.review_notes ?? p.reviewNotes, publishTime: p.scheduled_publish_time ?? p.scheduledPublishTime, createdAt: p.created_at ?? p.createdAt })));
  });

  tool('get_production', {
    title: 'Get production',
    description: 'One production: review status, blocking checks, editor metadata, provenance claims, discoverability findings, assets and scene health. detail="full" returns the raw bundle (large: script, SEO, all scene fields).',
    inputSchema: { productionId: z.string(), detail: z.enum(['summary', 'full']).default('summary') }, annotations: readOnly
  }, async ({ productionId, detail }) => {
    const bundle = await client.production(productionId);
    const content = bundle.content || bundle;
    return json(detail === 'full' ? content : summarizeProduction(content));
  });

  tool('get_script', { title: 'Get script', description: 'The production script (hook, introduction, sections, conclusion, CTA) and SEO metadata.', inputSchema: { productionId: z.string() }, annotations: readOnly },
    async ({ productionId }) => { const b = await client.production(productionId); const c = b.content || b; return json({ script: c.script, seo: c.seo, claims: c.script?.claims }); });

  tool('get_scenes', { title: 'Get scenes', description: 'Scene manifest: order, durations, narration text/state, visual prompt, asset origin.', inputSchema: { productionId: z.string() }, annotations: readOnly },
    async ({ productionId }) => { const b = await client.production(productionId); const c = b.content || b; return json((c.scenes || []).sort((a, x) => a.position - x.position).map(summarizeScene)); });

  tool('edit_metadata', {
    title: 'Edit metadata / review fields',
    description: 'Update editor fields on a production before approval: title, description, tags, privacyStatus, publishTime (ISO 8601), factChecked, rightsConfirmed, reviewNotes. Setting factChecked/rightsConfirmed is a human attestation — only do it when the operator has said so.',
    inputSchema: {
      productionId: z.string(), title: z.string().max(100).optional(), description: z.string().max(5000).optional(),
      tags: z.array(z.string()).max(30).optional(), privacyStatus: z.enum(PRIVACY).optional(), publishTime: z.string().optional(),
      factChecked: z.boolean().optional(), rightsConfirmed: z.boolean().optional(), reviewNotes: z.string().max(1000).optional()
    }, annotations: mutating
  }, async ({ productionId, ...editor }) => json(summarizeProduction(await client.editMetadata(productionId, editor))));

  tool('review_provenance', {
    title: 'Review provenance claims',
    description: 'Record evidence decisions for a production. claims: [{id, status: supported|waived|unsupported|pending, notes, sourceIds}]; sources: [{id?, url, title?, status: pending|verified|rejected, notes?}]. Rules enforced by Lumen: "supported" needs a verified source linked; "waived" needs a note. Omitted claims keep their current state. This is a human attestation — apply only what the operator decided.',
    inputSchema: {
      productionId: z.string(),
      claims: z.array(z.object({ id: z.string(), status: z.enum(['pending', 'supported', 'unsupported', 'waived']), notes: z.string().max(1000).optional(), sourceIds: z.array(z.string()).optional() })).optional(),
      sources: z.array(z.object({ id: z.string().optional(), url: z.string().url(), title: z.string().optional(), status: z.enum(['pending', 'verified', 'rejected']).default('pending'), notes: z.string().optional() })).optional(),
      containsSyntheticMedia: z.boolean().optional()
    }, annotations: mutating
  }, async ({ productionId, claims, sources, containsSyntheticMedia }) => {
    const bundle = await client.production(productionId); const current = (bundle.content || bundle).provenance || {};
    const byId = new Map((current.claims || []).map(c => [c.id, c]));
    for (const update of claims || []) {
      const existing = byId.get(update.id);
      if (!existing) throw new LumenError(`Unknown claim id ${update.id}`, { status: 404 });
      byId.set(update.id, { ...existing, ...update, notes: update.notes ?? existing.notes, sourceIds: update.sourceIds ?? existing.sourceIds });
    }
    const mergedSources = sources ? [...(current.sources || []), ...sources] : current.sources || [];
    const result = await client.reviewProvenance(productionId, { sources: mergedSources, claims: [...byId.values()], containsSyntheticMedia: containsSyntheticMedia ?? current.containsSyntheticMedia ?? false });
    return json(summarizeProduction(result));
  });

  tool('run_discoverability_audit', { title: 'Run DarkzSEO audit', description: 'Run the advisory DarkzSEO discoverability preflight (offline, free). Findings never block publishing.', inputSchema: { productionId: z.string(), platform: z.string().optional() }, annotations: mutating },
    async ({ productionId, platform }) => { await client.runDiscoverability(productionId, platform); const b = await client.production(productionId); return json(summarizeProduction(b.content || b).discoverability); });

  tool('review_discoverability_finding', { title: 'Review audit finding', description: 'Keep a DarkzSEO finding actionable or dismiss it with a reason (the reason carries to matching future findings).', inputSchema: { findingId: z.string(), status: z.enum(['actionable', 'dismissed']), reason: z.string().max(500).optional() }, annotations: mutating },
    async ({ findingId, status, reason }) => json(await client.reviewFinding(findingId, { status, reason })));

  // --------------------------------------------------------------- scenes
  tool('edit_scene', {
    title: 'Edit scene',
    description: 'Edit one scene: narration text (scriptText), visual prompt, label, duration (2–600 s), lock. Changing scriptText marks narration stale (regenerate it); changing prompt marks the visual stale; changing duration re-slices narration segments. factualChange=false skips adding a review claim for non-factual edits (intros, CTAs).',
    inputSchema: {
      productionId: z.string(), sceneId: z.string(), scriptText: z.string().max(10000).optional(), prompt: z.string().max(2000).optional(),
      label: z.string().max(120).optional(), duration: z.number().min(2).max(600).optional(), locked: z.boolean().optional(),
      factualChange: z.boolean().optional(), provenanceSourceIds: z.array(z.string()).optional()
    }, annotations: mutating
  }, async ({ productionId, sceneId, ...input }) => json(summarizeScene(await client.updateScene(productionId, sceneId, input))));

  tool('reorder_scenes', { title: 'Reorder scenes', description: 'Set the full scene order (all scene ids, new order). Requires a rebuild afterwards.', inputSchema: { productionId: z.string(), sceneIds: z.array(z.string()).min(1) }, annotations: mutating },
    async ({ productionId, sceneIds }) => json(await client.reorderScenes(productionId, sceneIds)));

  tool('estimate_scene_regeneration', { title: 'Estimate scene visual regeneration', description: 'Provider, model and generated seconds/cost class for regenerating one scene visual, without doing it.', inputSchema: { productionId: z.string(), sceneId: z.string(), provider: z.string().optional() }, annotations: readOnly },
    async ({ productionId, sceneId, provider }) => json(await client.sceneEstimate(productionId, sceneId, provider)));

  tool('regenerate_scene_visual', {
    title: 'Regenerate scene visual',
    description: 'Regenerate one scene image/clip from its prompt. COSTS MONEY (image ≈ $0.2; a paid video provider is priced per generated second). Requires confirm=true; paid video providers also need confirmPaid=true. Rebuild afterwards.',
    inputSchema: { productionId: z.string(), sceneId: z.string(), provider: z.string().optional(), confirm: z.boolean(), confirmPaid: z.boolean().optional() }, annotations: mutating
  }, async ({ productionId, sceneId, provider, confirm, confirmPaid }) => {
    requireConfirm(confirm, 'regenerate_scene_visual (spends provider credits)');
    return json(summarizeScene(await client.regenerateScene(productionId, sceneId, { provider, confirmPaid: confirmPaid === true })));
  });

  tool('regenerate_scene_narration', {
    title: 'Regenerate scene narration',
    description: 'Re-voice one scene from its current scriptText with the configured TTS provider (cents per scene). Requires confirm=true. Check the new audio length against the scene duration (edit_scene duration) and rebuild afterwards.',
    inputSchema: { productionId: z.string(), sceneId: z.string(), confirm: z.boolean() }, annotations: mutating
  }, async ({ productionId, sceneId, confirm }) => {
    requireConfirm(confirm, 'regenerate_scene_narration (spends TTS credits)');
    return json(summarizeScene(await client.regenerateNarration(productionId, sceneId, { confirmCost: true })));
  });

  tool('set_intentional_silence', {
    title: 'Intentional silence override',
    description: 'Declare the production intentionally silent (no narration) with a reason of at least 10 characters, or revert it. Operator decision — requires confirm=true.',
    inputSchema: { productionId: z.string(), enabled: z.boolean(), reason: z.string().min(10).max(500).optional(), confirm: z.boolean() }, annotations: mutating
  }, async ({ productionId, enabled, reason, confirm }) => { requireConfirm(confirm, 'set_intentional_silence'); return json(await client.silenceOverride(productionId, { enabled, reason, confirmed: true })); });

  tool('rebuild_video', {
    title: 'Rebuild final video',
    description: 'Re-render the final MP4 and captions from the current scene timeline and narration (no provider spend; CPU only). Slow: several minutes on a small server — the call blocks until done. Required after scene edits before approval.',
    inputSchema: { productionId: z.string() }, annotations: mutating
  }, async ({ productionId }) => json(await client.rebuild(productionId)));

  // -------------------------------------------------------------- publish
  tool('approve_and_schedule', {
    title: 'Approve & schedule',
    description: 'Approve a production for upload at publishTime with the given privacy. Lumen requires factChecked and rightsConfirmed to be true and all blocking checks to pass. These are human attestations: only call this after the operator explicitly confirmed both. Requires confirm=true.',
    inputSchema: {
      productionId: z.string(), privacyStatus: z.enum(PRIVACY).default('private'), publishTime: z.string().optional().describe('ISO 8601; omit to keep the scheduled time'),
      title: z.string().max(100).optional(), factChecked: z.literal(true), rightsConfirmed: z.literal(true), confirm: z.boolean()
    }, annotations: destructive
  }, async ({ productionId, confirm, ...input }) => { requireConfirm(confirm, 'approve_and_schedule (leads to a YouTube upload)'); return json(await client.approve(productionId, input)); });

  tool('unschedule_production', {
    title: 'Unschedule production',
    description: 'Remove an approved production from the publish queue before it uploads (entry kept as cancelled). The production returns to needs_review with both attestations cleared, scene repair is unlocked, and it must be approved again to upload. Requires confirm=true.',
    inputSchema: { productionId: z.string(), reason: z.string().max(500).optional(), confirm: z.boolean() }, annotations: destructive
  }, async ({ productionId, reason, confirm }) => { requireConfirm(confirm, 'unschedule_production (cancels a planned upload)'); return json(await client.unschedule(productionId, reason)); });

  tool('reject_production', { title: 'Reject production', description: 'Reject a production with notes; it will not be scheduled.', inputSchema: { productionId: z.string(), notes: z.string().max(1000).optional() }, annotations: destructive },
    async ({ productionId, notes }) => json(await client.reject(productionId, notes)));

  tool('retry_production', { title: 'Retry production', description: 'Start a brand-new generation job for the same topic/style/length. COSTS MONEY like generate_video. Requires confirm=true.', inputSchema: { productionId: z.string(), confirm: z.boolean() }, annotations: mutating },
    async ({ productionId, confirm }) => { requireConfirm(confirm, 'retry_production (spends credits)'); return json(summarizeJob(await client.retry(productionId))); });

  // --------------------------------------------------------------- shorts
  tool('propose_shorts', { title: 'Propose Shorts', description: 'Create up to N vertical Short drafts from an approved-quality production timeline (local, no provider spend).', inputSchema: { productionId: z.string(), count: z.number().int().min(1).max(6).default(3), replace: z.boolean().default(false) }, annotations: mutating },
    async ({ productionId, count, replace }) => json(await client.proposeShorts(productionId, { count, replace })));

  tool('update_short', { title: 'Update Short', description: 'Edit a Short draft: title, description, tags, layout (blurred_canvas | center_crop | stacked_focus). Layout changes invalidate the render.', inputSchema: { productionId: z.string(), clipId: z.string(), title: z.string().max(100).optional(), description: z.string().max(5000).optional(), tags: z.array(z.string()).optional(), layout: z.string().optional() }, annotations: mutating },
    async ({ productionId, clipId, ...input }) => json(await client.updateShort(productionId, clipId, input)));

  tool('render_short', { title: 'Render Short', description: 'Render the 9:16 MP4 with burned captions for a Short draft (local FFmpeg, no provider spend; takes a few minutes).', inputSchema: { productionId: z.string(), clipId: z.string() }, annotations: mutating },
    async ({ productionId, clipId }) => json(await client.renderShort(productionId, clipId)));

  tool('approve_short', { title: 'Approve Short', description: 'Approve and schedule a rendered Short (source production must be approved). Human decision — requires confirm=true.', inputSchema: { productionId: z.string(), clipId: z.string(), privacyStatus: z.enum(PRIVACY).default('private'), publishTime: z.string().optional(), confirm: z.boolean() }, annotations: destructive },
    async ({ productionId, clipId, confirm, ...input }) => { requireConfirm(confirm, 'approve_short (leads to a YouTube upload)'); return json(await client.approveShort(productionId, clipId, { ...input, confirmed: true })); });

  // ---------------------------------------------- profile / strategy / ops
  tool('update_profile', {
    title: 'Update channel profile',
    description: 'Channel identity used in every prompt: channelName, goal, targetAudience, brandVoice, defaultStyle, callToAction, visualStyle, timezone, bannedTopics.',
    inputSchema: { channelName: z.string().max(500).optional(), goal: z.string().max(500).optional(), targetAudience: z.string().max(500).optional(), brandVoice: z.string().max(500).optional(), defaultStyle: z.enum(STYLES).optional(), callToAction: z.string().max(500).optional(), visualStyle: z.string().max(500).optional(), timezone: z.string().max(100).optional(), bannedTopics: z.array(z.string()).max(50).optional() }, annotations: mutating
  }, async input => json(await client.updateProfile(input)));

  const strategyShape = {
    objective: z.string().max(1000).optional(), audience: z.string().max(1000).optional(), contentPillars: z.array(z.string().max(100)).min(1).max(8).optional(),
    cadencePerWeek: z.number().int().min(1).max(14).optional(), videosPerRun: z.number().int().min(1).max(5).optional(),
    defaultFormat: z.enum(STYLES).optional(), defaultLength: z.enum(LENGTHS).optional(),
    primaryKpi: z.enum(['views', 'watch_hours', 'subscribers', 'engagement', 'revenue']).optional(), targetValue: z.number().optional(), targetWindowDays: z.number().int().optional(),
    monthlyBudget: z.number().optional(), outcomeCurrency: z.string().regex(/^[A-Z]{3}$/).optional(), valueProposition: z.string().max(1000).optional(), constraints: z.string().max(1000).optional(),
    status: z.enum(['draft', 'active', 'paused']).optional()
  };

  tool('save_strategy', { title: 'Save channel strategy', description: 'Create or update the Autonomous Operator strategy (objective, audience, pillars, cadence, KPI, budget). Saving as draft/paused does not start anything.', inputSchema: strategyShape, annotations: mutating },
    async input => json(await client.saveStrategy(input)));

  tool('start_operator', {
    title: 'Activate operator & run now',
    description: 'Activate the saved strategy and start an autonomous research-and-production run: it will generate videosPerRun full productions. COSTS MONEY ($1–3 per video) and keeps the strategy active for the 06:00 schedule. Requires confirm=true.',
    inputSchema: { ...strategyShape, confirm: z.boolean() }, annotations: mutating
  }, async ({ confirm, ...input }) => { requireConfirm(confirm, 'start_operator (autonomous generation, spends credits)'); return json(await client.startOperator(input)); });

  tool('pause_operator', { title: 'Pause operator', description: 'Pause the channel strategy and cancel the active operator run if any.', inputSchema: {}, annotations: mutating },
    async () => json(await client.pauseOperator()));

  tool('resume_operator_run', { title: 'Resume operator run', description: 'Resume an interrupted Autonomous Operator run from its saved plan (continues unfinished items; may spend credits).', inputSchema: { runId: z.string(), confirm: z.boolean() }, annotations: mutating },
    async ({ runId, confirm }) => { requireConfirm(confirm, 'resume_operator_run (may spend credits)'); return json(await client.resumeOperatorRun(runId)); });

  tool('cancel_operator_run', { title: 'Cancel operator run', description: 'Cancel a running Autonomous Operator run.', inputSchema: { runId: z.string() }, annotations: destructive },
    async ({ runId }) => json(await client.cancelOperatorRun(runId)));

  tool('review_learning', { title: 'Approve/reject learning', description: 'Approve or reject an evidence-backed learning recommendation. Approved learnings become constraints for future operator planning. Human decision.', inputSchema: { recommendationId: z.string(), action: z.enum(['approve', 'reject']) }, annotations: mutating },
    async ({ recommendationId, action }) => json(await client.reviewLearning(recommendationId, action)));

  tool('set_automation', { title: 'Pause/resume automation', description: 'Pause or resume the daily scheduler (06:00 generation, publish queue, analytics). Pausing stops all autonomous spend.', inputSchema: { action: z.enum(['pause', 'resume']) }, annotations: mutating },
    async ({ action }) => json(await client.automation(action)));

  tool('update_settings', {
    title: 'Update settings',
    description: 'Runtime settings: video_provider (slideshow|seedance|minimax_h3|google_omni|kling|wan), video_generation_mode (auto|hybrid), video_clip_duration, video_max_generated_seconds, approval_required, daily_content_enabled (false stops the 06:00 generation but keeps the publish queue running), max_daily_posts, content_buffer_days, channel_timezone, notification_enabled. Switching to a paid video provider is a spend decision — requires confirm=true.',
    inputSchema: { settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), confirm: z.boolean().optional() }, annotations: mutating
  }, async ({ settings, confirm }) => {
    if (settings.video_provider && settings.video_provider !== 'slideshow') requireConfirm(confirm, 'switching to a paid video provider');
    return json(await client.updateSettings(settings));
  });

  // ------------------------------------------------------------ experiments
  tool('list_experiments', { title: 'List experiments', description: 'Controlled title/thumbnail experiments and eligible published videos.', inputSchema: {}, annotations: readOnly },
    async () => json(await client.experiments()));

  tool('create_experiment', { title: 'Create experiment plan', description: 'Draft a packaging experiment for a published production (arm duration 24–168 h, minimum impressions). Nothing changes on YouTube until approved and started.', inputSchema: { productionId: z.string(), armDurationHours: z.number().int().min(24).max(168).default(48), minImpressions: z.number().int().min(100).default(1000) }, annotations: mutating },
    async input => json(await client.createExperiment(input)));

  tool('experiment_action', { title: 'Experiment action', description: 'approve, start, adopt (apply the winner) or cancel an experiment. start rotates live YouTube title/thumbnail; adopt changes packaging permanently — both require confirm=true.', inputSchema: { experimentId: z.string(), action: z.enum(['approve', 'start', 'adopt', 'cancel']), confirm: z.boolean().optional() }, annotations: destructive },
    async ({ experimentId, action, confirm }) => { if (['start', 'adopt'].includes(action)) requireConfirm(confirm, `experiment ${action} (changes live YouTube metadata)`); return json(await client.experimentAction(experimentId, action, { confirmed: true })); });

  // ------------------------------------------------------ retention / engagement
  tool('get_retention', { title: 'Scene-aware retention', description: 'Stored audience-retention evidence for a published YouTube video id, mapped onto scenes.', inputSchema: { videoId: z.string() }, annotations: readOnly },
    async ({ videoId }) => json(await client.retention(videoId)));

  tool('refresh_retention', { title: 'Refresh retention', description: 'Read-only refresh of the retention curve from YouTube Analytics.', inputSchema: { videoId: z.string(), measurementWindow: z.string().optional() }, annotations: mutating },
    async ({ videoId, measurementWindow }) => json(await client.refreshRetention(videoId, measurementWindow)));

  tool('get_engagement', { title: 'Engagement insight', description: 'Comment themes, sentiment, questions, quarantined comments and reply drafts for a published video id.', inputSchema: { videoId: z.string() }, annotations: readOnly },
    async ({ videoId }) => json(await client.engagement(videoId)));

  tool('sync_engagement', { title: 'Sync comments', description: 'Fetch new comments for a video; analyze=true also classifies them with the text provider (small cost).', inputSchema: { videoId: z.string(), analyze: z.boolean().default(false) }, annotations: mutating },
    async ({ videoId, analyze }) => json(await client.syncEngagement(videoId, analyze)));

  tool('draft_replies', { title: 'Draft replies', description: 'Generate suggested replies in the channel voice (small text cost). Nothing is posted.', inputSchema: { videoId: z.string(), commentId: z.string().optional() }, annotations: mutating },
    async ({ videoId, commentId }) => json(await client.draftReplies(videoId, commentId ? { commentId } : {})));

  tool('update_reply_draft', { title: 'Edit reply draft', description: 'Edit the text of a reply draft before approval.', inputSchema: { draftId: z.string(), editedText: z.string().max(5000) }, annotations: mutating },
    async ({ draftId, editedText }) => json(await client.updateReplyDraft(draftId, { editedText })));

  tool('approve_reply', { title: 'Approve & post reply', description: 'Approve a reply draft — it is POSTED to YouTube in the channel\'s name. Human decision — requires confirm=true.', inputSchema: { draftId: z.string(), confirm: z.boolean() }, annotations: destructive },
    async ({ draftId, confirm }) => { requireConfirm(confirm, 'approve_reply (posts publicly on YouTube)'); return json(await client.approveReply(draftId, { confirmed: true })); });

  // ----------------------------------------------------------------- ideas
  tool('create_idea', { title: 'Create idea', description: 'Add a content idea to the backlog (no generation).', inputSchema: { topic: z.string().max(200), style: z.enum(STYLES).optional(), notes: z.string().max(1000).optional() }, annotations: mutating },
    async input => json(await client.createIdea(input)));

  tool('update_idea', { title: 'Update idea', description: 'Edit an idea: topic, style, notes, status.', inputSchema: { ideaId: z.string(), topic: z.string().max(200).optional(), style: z.enum(STYLES).optional(), notes: z.string().max(1000).optional(), status: z.string().optional() }, annotations: mutating },
    async ({ ideaId, ...input }) => json(await client.updateIdea(ideaId, input)));

  tool('generate_from_idea', { title: 'Generate from idea', description: 'Queue a full production for a backlog idea. COSTS MONEY like generate_video. Requires confirm=true.', inputSchema: { ideaId: z.string(), length: z.enum(LENGTHS).default('medium'), confirm: z.boolean() }, annotations: mutating },
    async ({ ideaId, length, confirm }) => { requireConfirm(confirm, 'generate_from_idea (spends credits)'); return json(summarizeJob(await client.generateIdea(ideaId, length))); });
}
