'use strict';

// Provider usage ledger: prices every OpenAI response from its `usage` object
// and records it against the job / production / scene that triggered the call.
// Attribution travels through AsyncLocalStorage so the agents and services do
// not need to thread identifiers through every call.

const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');

const MILLION = 1_000_000;
// The bundled table ships with the code; operators can override it with
// config/openai-pricing.json (config/ is a mounted volume in Docker) or
// OPENAI_PRICING_PATH without rebuilding the image.
const DEFAULT_PRICING_PATH = path.join(__dirname, 'openai-pricing.json');
const OVERRIDE_PRICING_PATH = path.join(__dirname, '..', 'config', 'openai-pricing.json');

function loadPricing(pricingPath = null) {
  const candidates = [pricingPath, process.env.OPENAI_PRICING_PATH, OVERRIDE_PRICING_PATH, DEFAULT_PRICING_PATH].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const pricing = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return { ...pricing, path: candidate };
    } catch (error) {
      lastError = error;
    }
  }
  return { version: 'missing', currency: 'USD', aliases: {}, models: {}, error: lastError?.message || 'no pricing file found' };
}

function round(amount) {
  return Number(amount.toFixed(6));
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

class UsageLedger {
  constructor(options = {}) {
    this.storage = new AsyncLocalStorage();
    this.store = null;
    this.pending = [];
    this.recent = [];
    this.recentLimit = options.recentLimit || 200;
    this.logger = options.logger || null;
    this.pricing = options.pricing || loadPricing(options.pricingPath);
  }

  get pricingVersion() {
    return this.pricing?.version || 'unknown';
  }

  context() {
    return this.storage.getStore() || {};
  }

  runWithContext(context, fn) {
    return this.storage.run({ ...this.context(), ...(context || {}) }, fn);
  }

  bindStore(store) {
    this.store = store || null;
    if (!this.store) return;
    for (const row of this.pending.splice(0)) void this.persist(row);
  }

  resolvePrice(model) {
    const models = this.pricing?.models || {};
    const aliases = this.pricing?.aliases || {};
    const raw = String(model || '');
    const candidates = [
      raw,
      raw.replace(/-\d{4}-\d{2}-\d{2}$/, ''),
      raw.split('/').pop(),
      raw.split('/').pop().replace(/-\d{4}-\d{2}-\d{2}$/, '')
    ];
    for (const candidate of candidates) {
      const key = models[candidate] ? candidate : aliases[candidate];
      if (key && models[key]) return { key, ...models[key] };
    }
    return null;
  }

  unpriced(units, price) {
    return { units, amount: null, currency: null, estimated: true, priceKey: price?.key || null };
  }

  priceChatCompletion({ model, usage }) {
    const input = count(usage?.prompt_tokens ?? usage?.input_tokens);
    const cached = Math.min(input, count(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens));
    const output = count(usage?.completion_tokens ?? usage?.output_tokens);
    const reasoning = count(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens);
    const units = { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningTokens: reasoning };
    const price = this.resolvePrice(model);
    if (!usage || !price || price.kind !== 'chat') return this.unpriced(units, price);
    const amount = ((input - cached) * price.input_per_million
      + cached * price.cached_input_per_million
      + output * price.output_per_million) / MILLION;
    return { units, amount: round(amount), currency: this.pricing.currency || 'USD', estimated: false, priceKey: price.key };
  }

  priceImage({ model, usage, count: images = 1, size = null, quality = null }) {
    const price = this.resolvePrice(model);
    const currency = this.pricing.currency || 'USD';
    if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
      const details = usage.input_tokens_details || {};
      const textIn = count(details.text_tokens);
      const imageIn = count(details.image_tokens);
      const cachedIn = Math.min(imageIn, count(details.cached_tokens));
      const output = count(usage.output_tokens);
      const units = { images, textInputTokens: textIn, imageInputTokens: imageIn, cachedImageInputTokens: cachedIn, imageOutputTokens: output, size, quality };
      if (!price || price.kind !== 'image') return this.unpriced(units, price);
      const amount = (textIn * price.text_input_per_million
        + (imageIn - cachedIn) * price.image_input_per_million
        + cachedIn * price.cached_image_input_per_million
        + output * price.image_output_per_million) / MILLION;
      return { units, amount: round(amount), currency, estimated: false, priceKey: price.key };
    }
    const units = { images, size, quality };
    const perImage = price?.fallback_per_image?.[size]?.[quality];
    if (!Number.isFinite(perImage)) return this.unpriced(units, price);
    return { units, amount: round(perImage * images), currency, estimated: true, priceKey: price.key };
  }

  priceSpeech({ model, inputCharacters = 0, audioSeconds = null }) {
    const price = this.resolvePrice(model);
    const characters = count(inputCharacters);
    const textTokens = Math.ceil(characters / 4);
    const seconds = audioSeconds === null || audioSeconds === undefined ? null : count(audioSeconds);
    const units = { inputCharacters: characters, estimatedTextInputTokens: textTokens, audioSeconds: seconds };
    if (!price || price.kind !== 'speech' || seconds === null || !Number.isFinite(price.audio_output_per_minute_estimate)) {
      return this.unpriced(units, price);
    }
    const amount = textTokens * price.text_input_per_million / MILLION + (seconds / 60) * price.audio_output_per_minute_estimate;
    return { units, amount: round(amount), currency: this.pricing.currency || 'USD', estimated: true, priceKey: price.key };
  }

  async record(entry = {}) {
    const context = this.context();
    const row = {
      id: `usage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      provider: entry.provider || 'openai',
      endpoint: entry.endpoint || null,
      model: entry.model || null,
      jobId: entry.jobId ?? context.jobId ?? null,
      productionId: entry.productionId ?? context.productionId ?? null,
      sceneId: entry.sceneId ?? context.sceneId ?? null,
      purpose: entry.purpose ?? context.purpose ?? null,
      units: entry.units || {},
      amount: Number.isFinite(entry.amount) ? entry.amount : null,
      currency: entry.currency || null,
      estimated: entry.estimated !== false,
      pricingVersion: this.pricingVersion,
      createdAt: new Date().toISOString()
    };
    this.recent.push(row);
    if (this.recent.length > this.recentLimit) this.recent.shift();
    if (this.store) await this.persist(row);
    else this.pending.push(row);
    return row;
  }

  async persist(row) {
    try {
      await this.store.recordProviderUsage(row);
    } catch (error) {
      this.logger?.warn?.(`Could not persist provider usage: ${error.message}`);
    }
  }
}

const ledger = new UsageLedger();

module.exports = { UsageLedger, ledger, loadPricing, DEFAULT_PRICING_PATH };
