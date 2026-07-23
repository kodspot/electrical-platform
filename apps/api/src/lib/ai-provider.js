'use strict';

/**
 * Single, shared AI-provider calling implementation. [WP10]
 *
 * Previously duplicated in three places (routes/ai.js, services/automation.js,
 * and — via automation.js — services/predictions.js indirectly): credential
 * resolution and the Azure OpenAI / Gemini HTTP-calling logic each had their
 * own independent copy. Consolidating here means every caller gets the same
 * error classification, the same credential-resolution rule (org key, then
 * global fallback), and — the specific gap this closes — the same circuit
 * breaker protection automatically, including automation.js's daily/weekly
 * AI-insight generation, which previously had none at all.
 *
 * callAiProvider() wraps every call in aiBreaker.exec() internally, so no
 * caller needs to remember to do so itself — the same design already used
 * for dbBreaker (see lib/prisma.js's Prisma Client Extension, [WP12]).
 */

const { decryptField } = require('./crypto');
const { aiBreaker } = require('./circuit-breaker');

// ── Credential resolution (org key, falling back to a global default key) ──

function getGlobalAiConfig() {
  const key = process.env.GLOBAL_AI_API_KEY;
  if (!key) return null;
  return {
    apiKey: key,
    provider: process.env.GLOBAL_AI_PROVIDER || 'gemini',
    model: process.env.GLOBAL_AI_MODEL || 'gemini-2.0-flash'
  };
}

function resolveAiCredentials(org) {
  if (org.aiApiKey) {
    const decrypted = decryptField(org.aiApiKey);
    if (decrypted) {
      return { apiKey: decrypted, provider: org.aiProvider, model: org.aiModel, keySource: 'org' };
    }
  }
  const global = getGlobalAiConfig();
  if (global) {
    return { apiKey: global.apiKey, provider: org.aiProvider || global.provider, model: org.aiModel || global.model, keySource: 'global' };
  }
  return null;
}

// ── Provider adapters ──
// Default timeout (45s) and token budget (2048) match routes/ai.js's
// pre-consolidation behavior, since its /chat endpoint relies on both
// defaults implicitly (it doesn't pass either explicitly). Every other
// caller already passes explicit values, so this default is never observed
// by them and changes nothing about their behavior.

async function callAzureOpenAI(apiKey, model, systemPrompt, userMessage, maxTokens, timeoutMs) {
  const parts = apiKey.split('|');
  let endpoint, key;

  if (parts.length === 2) {
    endpoint = parts[0].replace(/\/$/, '') + '/openai/deployments/' + encodeURIComponent(model || 'gpt-4o') + '/chat/completions?api-version=2025-01-01-preview';
    key = parts[1];
  } else {
    endpoint = 'https://api.openai.com/v1/chat/completions';
    key = apiKey;
  }

  const isAzure = endpoint.includes('openai.azure.com');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isAzure ? { 'api-key': key } : { 'Authorization': `Bearer ${key}` })
    },
    body: JSON.stringify({
      ...(isAzure ? {} : { model: model || 'gpt-4o' }),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: maxTokens || 2048,
      temperature: 0.3
    }),
    signal: AbortSignal.timeout(timeoutMs || 45000)
  });

  if (!res.ok) {
    const err = await res.text().catch(() => 'Unknown error');
    const status = res.status;
    if (status === 401 || status === 403) throw new Error('AZURE_AUTH_ERROR: Invalid API key or endpoint. Please check your Azure OpenAI configuration.');
    if (status === 404) throw new Error(`AZURE_MODEL_NOT_FOUND: Deployment "${model}" not found. Check the deployment name.`);
    if (status === 429) throw new Error('AZURE_RATE_LIMIT: API rate limit exceeded. Please wait and try again.');
    throw new Error(`Azure/OpenAI error (${status}): ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || 'No response generated.';
  const usage = data.usage || {};
  return {
    content,
    inputTokens: usage.prompt_tokens || null,
    outputTokens: usage.completion_tokens || null,
    totalTokens: usage.total_tokens || null
  };
}

async function callGemini(apiKey, model, systemPrompt, userMessage, maxTokens, timeoutMs) {
  const modelName = encodeURIComponent(model || 'gemini-2.0-flash');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

  // Gemini 2.5+ models support "thinking" — configure appropriately
  const isThinkingModel = /gemini-2\.[5-9]|gemini-[3-9]/.test(model || '');
  const generationConfig = {
    maxOutputTokens: maxTokens || 2048,
    temperature: isThinkingModel ? undefined : 0.3
  };
  if (isThinkingModel) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig
    }),
    signal: AbortSignal.timeout(timeoutMs || 45000)
  });

  if (!res.ok) {
    const err = await res.text().catch(() => 'Unknown error');
    const status = res.status;
    if (status === 400) throw new Error(`GEMINI_BAD_REQUEST: ${err.slice(0, 300)}`);
    if (status === 401 || status === 403) throw new Error('GEMINI_AUTH_ERROR: Invalid API key. Please check your Gemini API key in AI settings.');
    if (status === 404) throw new Error(`GEMINI_MODEL_NOT_FOUND: Model "${model}" not found. Check the model name.`);
    if (status === 429) throw new Error('GEMINI_RATE_LIMIT: API rate limit exceeded. Please wait and try again.');
    throw new Error(`Gemini error (${status}): ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts;
  let content = 'No response generated.';
  if (Array.isArray(parts)) {
    const textParts = parts.filter(p => p.text && !p.thought).map(p => p.text);
    if (textParts.length) content = textParts.join('\n');
    else {
      const anyText = parts.filter(p => p.text).map(p => p.text);
      if (anyText.length) content = anyText[anyText.length - 1];
    }
  }

  const usage = data.usageMetadata || {};
  return {
    content,
    inputTokens: usage.promptTokenCount || null,
    outputTokens: usage.candidatesTokenCount || null,
    totalTokens: usage.totalTokenCount || null
  };
}

/**
 * Dispatch to the configured provider, through the AI circuit breaker.
 * Unrecognized providers silently fall through to Gemini — this matches the
 * pre-consolidation behavior of automation.js/predictions.js exactly.
 * routes/ai.js's own explicit "reject an unsupported provider" validation
 * (a 400 response) runs before this is ever called, so that behavior is
 * unaffected — it never reaches this permissive fallback.
 */
async function callAiProvider(creds, systemPrompt, userMessage, maxTokens, timeoutMs) {
  return aiBreaker.exec(() => {
    const provider = creds.provider || 'gemini';
    if (provider === 'azure-openai') {
      return callAzureOpenAI(creds.apiKey, creds.model, systemPrompt, userMessage, maxTokens, timeoutMs);
    }
    return callGemini(creds.apiKey, creds.model, systemPrompt, userMessage, maxTokens, timeoutMs);
  });
}

module.exports = {
  getGlobalAiConfig,
  resolveAiCredentials,
  callAiProvider
};
