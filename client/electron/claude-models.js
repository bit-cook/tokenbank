'use strict';

// Official public, active Claude API models, checked 2026-09-20.
// https://platform.claude.com/docs/en/models/overview
// https://platform.claude.com/docs/en/about-claude/model-deprecations
// A catalog entry is not a guarantee of OAuth plan entitlement. Invitation-only
// Mythos models and retired models are deliberately not added to defaults.
const DEFINITIONS = Object.freeze([
  { name: 'claude-opus-5', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true },
  { name: 'claude-sonnet-5', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true },
  { name: 'claude-haiku-4-5-20251001', context_window: 200000, max_output_tokens: 64000 },
  { name: 'claude-fable-5-1', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true, alwaysThinking: true },
  { name: 'claude-fable-5', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true, alwaysThinking: true },
  { name: 'claude-opus-4-8', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true },
  { name: 'claude-opus-4-7', context_window: 1000000, max_output_tokens: 128000, adaptiveOnly: true },
  { name: 'claude-opus-4-6', context_window: 1000000, max_output_tokens: 128000 },
  { name: 'claude-sonnet-4-6', context_window: 1000000, max_output_tokens: 128000 },
  { name: 'claude-opus-4-5-20251101', context_window: 200000, max_output_tokens: 64000 },
  { name: 'claude-sonnet-4-5-20250929', context_window: 200000, max_output_tokens: 64000 },
].map(Object.freeze));

function claudeModelInfo(name) {
  const id = String(name || '').toLowerCase();
  return DEFINITIONS.find((m) => m.name === id || m.name.replace(/-\d{8}$/, '') === id) || null;
}

function claudeOAuthModels() {
  return DEFINITIONS.map(({ name, context_window, max_output_tokens }) => ({
    name, type: 'chat', vision: true, context_window, max_output_tokens,
  }));
}

function isClaudeOAuthProvider(provider) {
  if (!provider) return false;
  if (provider.oauth_provider === 'claude' || provider.oauth?.provider === 'claude') return true;
  if (provider.auth_type !== 'oauth') return false;
  try { return new URL(provider.base_url).hostname === 'api.anthropic.com'; } catch { return false; }
}

// Empty lists include catalog-sync resets; explicit selections remain authoritative.
function withClaudeOAuthModels(provider) {
  if (!isClaudeOAuthProvider(provider) || (Array.isArray(provider.models) && provider.models.length)) return provider;
  return { ...provider, models: claudeOAuthModels() };
}

// Apply only in Claude OAuth's outbound body hook, after protocol conversion.
// Migration guides: /models/opus-5/migration-guide and /models/fable-5-1/migration-guide.
function normalizeClaudeOAuthBody(body) {
  const info = claudeModelInfo(body?.model);
  if (!info || !body || typeof body !== 'object') return body;
  const out = { ...body };
  if (Number.isFinite(out.max_tokens) && out.max_tokens > info.max_output_tokens) {
    out.max_tokens = info.max_output_tokens;
  }
  if (info.adaptiveOnly) {
    delete out.temperature;
    delete out.top_p;
    delete out.top_k;
    const thinking = out.thinking;
    if (thinking && (thinking.type === 'enabled' || thinking.type === 'adaptive'
      || (info.alwaysThinking && thinking.type === 'disabled'))) {
      out.thinking = { ...thinking, type: 'adaptive' };
      delete out.thinking.budget_tokens;
    }
  }
  // Preserve explicit tool choice and signed history. Incompatible forced-tool
  // requests on Fable 5.1 must not silently become optional tool use.
  return out;
}

module.exports = { claudeModelInfo, claudeOAuthModels, isClaudeOAuthProvider, withClaudeOAuthModels, normalizeClaudeOAuthBody };
