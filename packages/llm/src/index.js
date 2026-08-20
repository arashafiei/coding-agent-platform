import { ChatOpenAI } from '@langchain/openai';

export function getLLMConfig() {
  return {
    provider: process.env.LLM_PROVIDER || 'openai-compatible',
    baseURL: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL || 'gpt-5.6-luna',
    temperature: Number(process.env.LLM_TEMPERATURE || 0.2),
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 8192),
    timeout: Number(process.env.LLM_TIMEOUT_MS || 45000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES || 0)
  };
}

export function createLLM(overrides = {}) {
  const cfg = getLLMConfig();
  if (!cfg.apiKey) throw new Error('LLM_API_KEY is not configured');
  if (cfg.provider !== 'openai-compatible') {
    throw new Error(`Unsupported LLM_PROVIDER: ${cfg.provider}. Add an adapter in packages/llm.`);
  }
  return new ChatOpenAI({
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: overrides.maxTokens ?? cfg.maxTokens,
    timeout: cfg.timeout,
    maxRetries: cfg.maxRetries,
    configuration: cfg.baseURL ? { baseURL: cfg.baseURL } : undefined
  });
}
