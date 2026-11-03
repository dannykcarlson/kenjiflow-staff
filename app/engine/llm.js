// Model provider interface. Claude is the default; "mock" runs the whole app
// without an API key (demos, tests). Other providers slot in behind create().
const { mockCreate } = require('./mock-llm');

// $ per million tokens: input, output, cache read, cache write (5 min)
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
};

function costOf(model, usage = {}) {
  const [i, o, cr, cw] = PRICES[model] || PRICES['claude-opus-5-5'];
  return ((usage.input_tokens || 0) * i + (usage.output_tokens || 0) * o
    + (usage.cache_read_input_tokens || 0) * cr + (usage.cache_creation_input_tokens || 0) * cw) / 1e6;
}

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

// apiKey: the key saved in Settings. Without one, the SDK's own environment lookup
// (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, e.g. from .env) is used; with neither, demo mode.
function createLLM({ provider, apiKey, model = 'claude-opus-5-5', effort = 'medium' } = {}) {
  const chosen = provider || (apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'anthropic' : 'mock');

  if (chosen === 'mock') {
    return { provider: 'mock', model: 'mock', keySource: null, costOf: () => 0, create: async (req) => mockCreate(req) };
  }

  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();

  return {
    provider: 'anthropic',
    model,
    keySource: apiKey ? 'settings' : 'environment',
    costOf: (usage) => costOf(model, usage),
    Anthropic,
    async create({ system, tools, messages }) {
      return client.beta.messages.create({
        model,
        max_tokens: 16000,
        // Stable prefix (tools + system) first, so the prompt cache covers it.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages,
        output_config: { effort },
        // If an Admin edits a bot's instructions or the business details, earlier
        // thinking no longer matches the conversation; drop it instead of failing.
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        // If Claude declines on a safety classifier, the API reroutes to a fallback model.
        betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'],
        fallbacks: 'default',
      });
    },
  };
}

// One stable object the runtime holds; swap() changes the provider behind it
// (e.g. when an Owner saves a new Claude key) without restarting the engine.
function createSwitchableLLM(initial) {
  let current = initial;
  return {
    get provider() { return current.provider; },
    get model() { return current.model; },
    get keySource() { return current.keySource; },
    get Anthropic() { return current.Anthropic; },
    costOf: (usage) => current.costOf(usage),
    create: (req) => current.create(req),
    swap(next) { current = next; },
  };
}

// Checks a key without spending tokens: looking up a model needs a valid key.
async function checkApiKey(apiKey, model = 'claude-opus-5-5') {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15000 });
  try {
    await client.models.retrieve(model);
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Anthropic rejected that key. Check it was copied in full.' };
    if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: `That key can't use ${model}. Check the workspace's model access.` };
    if (err instanceof Anthropic.NotFoundError) return { ok: false, error: `That key works, but ${model} isn't available to it.` };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, error: "Couldn't reach Anthropic. Check the server's internet connection." };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Anthropic returned an error (${err.status}).` };
    throw err;
  }
}

// Plain-language reason for a failed model call, shown in chat.
function describeError(err, llm) {
  const A = llm && llm.Anthropic;
  if (A) {
    if (err instanceof A.AuthenticationError) return "I can't reach Claude: the API key was rejected. An Owner can fix it in Settings.";
    if (err instanceof A.RateLimitError) return "Claude is rate-limiting us right now. I'll be able to pick this up again in a minute.";
    if (err instanceof A.BadRequestError) return `Claude rejected the request (${err.message}).`;
    if (err instanceof A.APIError) return `Claude returned an error (${err.status}). Try again shortly.`;
  }
  return `Something went wrong on my side: ${err.message}`;
}

module.exports = { createLLM, createSwitchableLLM, checkApiKey, costOf, describeError };
