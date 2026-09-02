const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { Logger } = require('./logger');
const { ledger } = require('./usage-ledger');

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.7-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
};

// gpt-5.x and o-series models reason before answering; see generateText().
const REASONING_HEADROOM_TOKENS = 6000;
function isReasoningModel(model) {
  return /^(gpt-5|o[1-9])/i.test(String(model || ''));
}

const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';
const ANTHROPIC_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
// Claude 5 models think adaptively and the thinking tokens count toward
// max_tokens, so the visible-answer budget needs headroom on top.
const ANTHROPIC_THINKING_HEADROOM = 6000;

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.anthropic = null;
    this.model = null;
    this.providerName = null;

    this._init(credentials);
  }

  _init(credentials) {
    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    if (provider === 'anthropic' && apiKey) {
      return this._initAnthropic(apiKey, model);
    }
    if (provider && PROVIDERS[provider] && apiKey) {
      return this._initOpenAICompatible(PROVIDERS[provider], apiKey, model);
    }

    const anthropicKey = credentials.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      return this._initAnthropic(anthropicKey, credentials.anthropic?.model);
    }

    // The setup walkthrough stores the OpenAI key as credentials.openai (it is
    // shared with image generation and TTS), not under aiProvider.
    if (credentials.openai?.apiKey) {
      return this._initOpenAICompatible(PROVIDERS.openai, credentials.openai.apiKey, credentials.openai.model);
    }

    for (const [, preset] of Object.entries(PROVIDERS)) {
      const key = process.env[preset.envKey];
      if (key) {
        return this._initOpenAICompatible(preset, key);
      }
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      return this._initGemini(geminiKey, credentials.gemini?.model);
    }

    this.logger.warn('No AI text provider configured — text generation unavailable');
  }

  _initOpenAICompatible(preset, apiKey, model) {
    this.client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.providerKey = Object.keys(PROVIDERS).find(key => PROVIDERS[key] === preset) || 'openai-compatible';
    this.logger.info(`${preset.name} initialized (model: ${this.model})`);
  }

  _initAnthropic(apiKey, model) {
    this.anthropic = new Anthropic({ apiKey });
    this.model = model || ANTHROPIC_DEFAULT_MODEL;
    this.providerName = 'Anthropic Claude';
    this.providerKey = 'anthropic';
    this.logger.info(`Anthropic initialized (model: ${this.model})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || GEMINI_DEFAULT_MODEL;
      this.providerName = 'Google Gemini';
      this.providerKey = 'gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  async generateText(prompt, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    if (this.anthropic) {
      // Claude 5 models reject sampling parameters (temperature et al.) and
      // think adaptively by default, so the request stays minimal.
      const response = await this.anthropic.messages.create({
        model,
        max_tokens: maxTokens + ANTHROPIC_THINKING_HEADROOM,
        messages: [{ role: 'user', content: prompt }]
      });
      if (response.usage) {
        const priced = ledger.priceChatCompletion({ model: response.model || model, usage: response.usage });
        void ledger.record({ provider: 'anthropic', endpoint: 'messages', model: response.model || model, ...priced });
      }
      if (response.stop_reason === 'refusal') {
        const detail = response.stop_details?.explanation || response.stop_details?.category || 'safety refusal';
        throw new Error(`${this.providerName} declined this request (${detail}). Rephrase the prompt or route it to another provider.`);
      }
      const text = (response.content || [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();
      if (!text) {
        throw new Error(response.stop_reason === 'max_tokens'
          ? `${this.providerName} hit max_tokens before producing text. Increase maxTokens.`
          : `${this.providerName} returned an empty response.`);
      }
      return text;
    }

    if (this.gemini) {
      const config = { maxOutputTokens: maxTokens };
      if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(model)) config.temperature = temperature;
      const response = await this.gemini.models.generateContent({
        model,
        contents: prompt,
        config,
      });
      const text = response && response.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(
          `${this.providerName} returned an empty response. Check the API key and model quota — free-tier Gemini keys are rate-limited and can return empty output.`
        );
      }
      return text;
    }

    if (!this.client) {
      throw new Error('No AI text provider configured');
    }

    const params = {
      model,
      messages: [{ role: 'user', content: prompt }],
    };
    let completionBudget = maxTokens;
    if (isReasoningModel(model)) {
      // Reasoning models (gpt-5.x, o-series) accept only the default temperature,
      // and max_completion_tokens also covers their hidden reasoning tokens. A
      // budget sized for the visible answer alone gets consumed by reasoning and
      // the reply comes back empty. Keep reasoning short and leave headroom.
      params.reasoning_effort = 'low';
      completionBudget = maxTokens + REASONING_HEADROOM_TOKENS;
    } else {
      params.temperature = temperature;
    }

    // Newer OpenAI models (gpt-5.x and later) reject the legacy max_tokens
    // parameter and require max_completion_tokens; older models and some
    // providers do the opposite. Try the modern spelling first.
    const attempts = [
      { ...params, max_completion_tokens: completionBudget },
      { ...params, max_tokens: completionBudget },
    ];

    let lastError;
    for (let request of attempts) {
      try {
        return this._extractContent(await this.client.chat.completions.create(request), request);
      } catch (error) {
        lastError = error;
        if (!error || error.status !== 400) throw error;
        const message = error.message || '';
        // Some OpenAI-compatible providers do not know reasoning_effort.
        if (/reasoning_effort/i.test(message) && 'reasoning_effort' in request) {
          const { reasoning_effort: _omitEffort, ...withoutEffort } = request;
          return this._extractContent(await this.client.chat.completions.create(withoutEffort), withoutEffort);
        }
        // Reasoning models (gpt-5.x family) only accept the default temperature
        // and return 400 for anything else. Retry the same request without it.
        if (/temperature/i.test(message) && 'temperature' in request) {
          const { temperature: _omit, ...withoutTemperature } = request;
          try {
            return this._extractContent(await this.client.chat.completions.create(withoutTemperature), withoutTemperature);
          } catch (retryError) {
            lastError = retryError;
            if (!retryError || retryError.status !== 400) throw retryError;
            if (!/max(_completion)?_tokens/i.test(retryError.message || '')) throw retryError;
            // fall through to the next max_tokens spelling
            continue;
          }
        }
        if (!/max(_completion)?_tokens/i.test(message)) throw error;
      }
    }
    throw lastError;
  }

  // Every OpenAI response carries a `usage` object; price it and hand it to the
  // ledger so the dashboard can show what each production actually cost.
  _recordUsage(response, request = {}) {
    if (!response?.usage) return;
    const model = response.model || request.model || this.model;
    const priced = ledger.priceChatCompletion({ model, usage: response.usage });
    void ledger.record({ provider: this.providerKey || 'openai', endpoint: 'chat.completions', model, ...priced });
  }

  _extractContent(response, request = {}) {
    this._recordUsage(response, request);
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      const finishReason = response?.choices?.[0]?.finish_reason;
      if (finishReason === 'length') {
        throw new Error(
          `${this.providerName} hit the completion token limit before producing any text (reasoning tokens consumed the budget). Increase maxTokens or use a lower reasoning effort.`
        );
      }
      // A null/empty body used to surface as cryptic "Unexpected end of JSON input"
      // in the agents' JSON parsers. Report the real cause instead.
      throw new Error(
        `${this.providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini || this.anthropic);
  }
}

module.exports = { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL, ANTHROPIC_MODELS, ANTHROPIC_DEFAULT_MODEL };
