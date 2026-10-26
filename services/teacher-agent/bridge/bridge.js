#!/usr/bin/env node

import Fastify from "fastify";
import { provider } from "./provider.js";
import { authenticateScope, responseKey, ownedResponse, modelConfigDigest } from "./isolation.js";
import { portableNativeInput } from "./native-history.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { timeout: 30_000 },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000
}));

const VERBOSITY = process.argv.filter(arg => /^-v+$/.test(arg)).reduce((max, arg) => Math.max(max, arg.length - 1), 0);
const LOG_LEVEL = VERBOSITY >= 2 ? "debug" : VERBOSITY >= 1 ? "info" : "warn";

const app = Fastify({ logger: { level: LOG_LEVEL }, bodyLimit: 20 * 1024 * 1024 });

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const MODELHUB_BASE =
  provider.base;
const MODELHUB_AK = provider.key;
const MODELHUB_MODEL = provider.model;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 8192);

function normalizeModel() {
  return MODELHUB_MODEL;
}

// Single source of truth for client-supplied output-token limits. OpenAI's
// Responses API uses `max_output_tokens`, Chat Completions historically used
// `max_tokens` and newly uses `max_completion_tokens`, Anthropic uses
// `max_tokens`. Accept all four, fall back to default.
function pickMaxOutputTokens(body, fallback = DEFAULT_MAX_OUTPUT_TOKENS) {
  if (!body || typeof body !== "object") return fallback;
  return Math.min(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? fallback, DEFAULT_MAX_OUTPUT_TOKENS);
}

function isProbeMaxTokens(body) {
  if (!body || typeof body !== "object") return false;
  return body.max_tokens === 1 || body.max_output_tokens === 1 || body.max_completion_tokens === 1;
}
const PAYLOAD_LOG_DIR = process.env.PAYLOAD_LOG_DIR || "/tmp/modelhub-bridge-logs";
const PAYLOAD_LOG_BASE64_PLACEHOLDER = "[BASE64_OMITTED]";
const PAYLOAD_LOG_RETENTION_HOURS = Number(process.env.PAYLOAD_LOG_RETENTION_HOURS || 168);
const PAYLOAD_LOG_ENABLED = process.env.PAYLOAD_LOG_ENABLED === "true";
const STORE_TTL_MS = Number(process.env.STORE_TTL_MS || 24 * 60 * 60 * 1000);
const STORE_SWEEP_INTERVAL_MS = Number(process.env.STORE_SWEEP_INTERVAL_MS || 60 * 60 * 1000);

if (!MODELHUB_AK) throw new Error("Missing upstream API key");
if (!BRIDGE_API_KEY) throw new Error("Missing BRIDGE_API_KEY");
if (!(STORE_TTL_MS > 0)) throw new Error("STORE_TTL_MS must be positive");

const store = new Map();
const conversationSessions = new Map();
const conversationLastUsed = new Map();

function touchConversation(conversationKey) {
  if (conversationKey) conversationLastUsed.set(conversationKey, Date.now());
}

function sweepStaleEntries() {
  if (STORE_TTL_MS <= 0) return;
  const cutoff = Date.now() - STORE_TTL_MS;
  let removedResponses = 0;
  let removedConversations = 0;
  for (const [id, entry] of store) {
    if ((entry.createdAt ?? 0) < cutoff) {
      store.delete(id);
      removedResponses++;
    }
  }
  const liveConversations = new Set();
  for (const entry of store.values()) {
    if (entry.conversationKey) liveConversations.add(entry.conversationKey);
  }
  for (const [key, lastUsed] of conversationLastUsed) {
    if (liveConversations.has(key)) continue;
    if (lastUsed < cutoff) {
      conversationSessions.delete(key);
      conversationLastUsed.delete(key);
      removedConversations++;
    }
  }
  if (removedResponses || removedConversations) {
    app.log.info({ removedResponses, removedConversations, storeSize: store.size, conversationSize: conversationSessions.size }, "store sweep");
  }
}

if (STORE_TTL_MS > 0 && STORE_SWEEP_INTERVAL_MS > 0) {
  setInterval(sweepStaleEntries, STORE_SWEEP_INTERVAL_MS).unref();
}

const payloadLogger = PAYLOAD_LOG_ENABLED ? createPayloadLogger() : null;

function createPayloadLogger() {
  fs.mkdirSync(PAYLOAD_LOG_DIR, { recursive: true });
  const transport = pino.transport({
    target: "pino-roll",
    options: {
      file: path.join(PAYLOAD_LOG_DIR, "payload.jsonl"),
      frequency: "hourly",
      dateFormat: "yyyy-MM-dd-HH",
      mkdir: true,
      symlink: true,
      limit: PAYLOAD_LOG_RETENTION_HOURS > 0 ? { count: PAYLOAD_LOG_RETENTION_HOURS, removeOtherLogFiles: true } : undefined
    }
  });
  return pino({
    base: null,
    formatters: {
      level: label => ({ level: label })
    },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`
  }, transport);
}

const now = () => Math.floor(Date.now() / 1000);
const rid = p => `${p}_${crypto.randomUUID().replace(/-/g, "")}`;

function safeLogFilePart(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function requestLogId() {
  const iso = new Date().toISOString();
  const compact = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}_${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}_${iso.slice(20, 23)}`;
  return `${compact}_${crypto.randomUUID().slice(0, 8)}`;
}
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive"
};


function hasAnthropicApiKey(headers = {}) {
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function getBearerToken(headers = {}) {
  const auth = headers.authorization;
  const match = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : null;
  return match?.[1]?.trim() || null;
}

function getAnthropicApiKey(headers = {}) {
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey.trim() : null;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function verifyClientAuth(req, reply, done) {
  if (req.routeOptions.url === "/health") return done();
  try {
    req.bridgeScope = authenticateScope(req.headers, BRIDGE_API_KEY);
    req.bridgeConfigDigest = req.headers['x-exp-modelhub-config-digest'];
    if (req.bridgeConfigDigest && (req.bridgeConfigDigest !== modelConfigDigest(process.env, MODELHUB_MODEL)
        || (req.body?.model && req.body.model !== MODELHUB_MODEL))) {
      reply.code(409).send({error: {message: 'CODEX_ROUTE_CONFIG_MISMATCH', type: 'configuration_error'}});
      return;
    }
    if (req.headers['x-exp-modelhub-session-id']) {
      const bound = req.headers['x-exp-modelhub-session-id'];
      if (conversationSessions.has(req.bridgeScope) && conversationSessions.get(req.bridgeScope) !== bound) {
        throw new Error('Conversation session binding cannot change');
      }
      conversationSessions.set(req.bridgeScope, bound);
    }
    done();
  } catch (error) {
    reply.code(401).send({ error: { message: error.message, type: "authentication_error" } });
  }
}

function buildOpenAIModelsResponse() {
  return {
    object: "list",
    data: [{
      id: MODELHUB_MODEL,
      object: "model",
      created: now(),
      owned_by: "openai",
      provider: "openai"
    }]
  };
}

const ANTHROPIC_MODEL_CAPABILITIES = {
  batch: { supported: true },
  citations: { supported: true },
  code_execution: { supported: true },
  context_management: {
    supported: true,
    clear_tool_uses_20250919: { supported: true },
    clear_thinking_20251015: { supported: true },
    compact_20260112: { supported: true }
  },
  effort: {
    supported: true,
    low: { supported: true },
    medium: { supported: true },
    high: { supported: true },
    max: { supported: true }
  },
  image_input: { supported: true },
  pdf_input: { supported: true },
  structured_outputs: { supported: true },
  thinking: {
    supported: true,
    types: {
      enabled: { supported: true },
      adaptive: { supported: true }
    }
  }
};

function buildAnthropicModelsResponse() {
  const models = [
    { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", created_at: "2026-04-01T00:00:00Z" },
    { id: "claude-opus-4-6", display_name: "Claude Opus 4.6", created_at: "2026-02-04T00:00:00Z" },
    { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-02-17T00:00:00Z" }
  ];
  return {
    data: models.map(m => ({
      type: "model",
      ...m,
      max_input_tokens: 1000000,
      max_tokens: 128000,
      capabilities: ANTHROPIC_MODEL_CAPABILITIES
    })),
    has_more: false,
    first_id: models[0].id,
    last_id: models[models.length - 1].id
  };
}

function deepClone(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

function isProbablyBase64String(value) {
  if (typeof value !== "string") return false;
  if (value.startsWith("data:") && value.includes(";base64,")) return true;
  if (value.length < 1024) return false;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isSensitivePayloadLogKey(key) {
  return key === "authorization" ||
    key === "proxy-authorization" ||
    key === "x-api-key" ||
    key === "cookie" ||
    key === "set-cookie" ||
    key.includes("api_key") ||
    key.includes("access_token") ||
    key.includes("refresh_token") ||
    key.includes("password") ||
    key === "ak";
}

function sanitizeForPayloadLog(value) {
  if (value == null) return value;

  if (typeof value === "string") {
    if (isProbablyBase64String(value)) {
      return `${PAYLOAD_LOG_BASE64_PLACEHOLDER}(chars=${value.length},sha256=${crypto.createHash("sha256").update(value).digest("hex")})`;
    }
    return value;
  }

  if (Array.isArray(value)) return value.map(item => sanitizeForPayloadLog(item));

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = k.toLowerCase();
      if (isSensitivePayloadLogKey(key)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeForPayloadLog(v);
      }
    }
    return out;
  }

  return value;
}

function summarizeMessageItem(item) {
  if (!item || typeof item !== "object") return item;
  const role = item.role || item.type;
  const contentLen = typeof item.content === "string"
    ? item.content.length
    : Array.isArray(item.content)
      ? item.content.reduce((n, p) => n + (typeof p === "string" ? p.length : (p?.text?.length || 0)), 0)
      : 0;
  return {
    role,
    type: item.type,
    name: item.name,
    call_id: item.call_id,
    content_chars: contentLen || undefined
  };
}

function summarizeArrayField(arr) {
  if (!Array.isArray(arr)) return arr;
  const tail = arr.slice(-2);
  return {
    total: arr.length,
    sha256: crypto.createHash("sha256").update(JSON.stringify(arr)).digest("hex").slice(0, 16),
    summary: arr.map(summarizeMessageItem),
    tail
  };
}

function compactModelhubInputBody(body) {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  if (Array.isArray(out.input)) out.input = summarizeArrayField(out.input);
  if (Array.isArray(out.messages)) out.messages = summarizeArrayField(out.messages);
  return out;
}

function buildLogTopLevel(event, payload) {
  const top = {};
  if (payload && typeof payload === "object") {
    if (payload.session_id) top.session_id = payload.session_id;
    if (payload.path) top.path = payload.path;
    if (payload.status != null) top.status = payload.status;
    if (payload.attempt != null) top.attempt = payload.attempt;
    if (payload.model) top.model = payload.model;
    if (payload.body && typeof payload.body === "object") {
      if (!top.model && payload.body.model) top.model = payload.body.model;
      if (payload.body.stream != null) top.stream = !!payload.body.stream;
    }
    if (payload.method) top.method = payload.method;
    if (payload.url) top.url = payload.url;
    if (payload.error) top.error = String(payload.error).slice(0, 200);
    if (payload.duration_ms != null) top.duration_ms = payload.duration_ms;
  }
  return top;
}

function appendPayloadLog(reqLog, event, payload = {}) {
  if (!reqLog || !payloadLogger) return;
  let outPayload = payload;
  if (event === "modelhub_input" && payload?.body) {
    outPayload = { ...payload, body: compactModelhubInputBody(payload.body) };
  }
  const sanitized = sanitizeForPayloadLog(outPayload);
  const top = buildLogTopLevel(event, sanitized);
  payloadLogger.info({
    request_id: reqLog.id,
    api: reqLog.api,
    event,
    ...top,
    msg: `${reqLog.api} ${event}${top.status != null ? ` ${top.status}` : ""}`,
    payload: sanitized
  });
}

function initPayloadLog(req, api, body) {
  const reqLog = { id: requestLogId(), api: safeLogFilePart(api) };
  if (!payloadLogger) return reqLog;
  appendPayloadLog(reqLog, "client_input", {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body
  });
  return reqLog;
}

function asArray(x) {
  return Array.isArray(x) ? x : x == null ? [] : [x];
}

function normalizePart(part, role = "user") {
  if (!part) return part;
  if (part.type === "input_text") {
    return role === "assistant"
      ? { type: "output_text", text: part.text ?? "", annotations: [], logprobs: [] }
      : part;
  }
  if (part.type === "text") {
    return role === "assistant"
      ? { type: "output_text", text: part.text ?? "", annotations: [], logprobs: [] }
      : { type: "input_text", text: part.text ?? "" };
  }
  if (part.type === "output_text") {
    return role === "assistant"
      ? { type: "output_text", text: part.text ?? "", annotations: part.annotations || [], logprobs: part.logprobs || [] }
      : { type: "input_text", text: part.text ?? "" };
  }
  if (part.type === "refusal") {
    return role === "assistant"
      ? { type: "refusal", refusal: part.refusal ?? part.text ?? "" }
      : { type: "input_text", text: part.refusal ?? part.text ?? "" };
  }
  if (part.type === "input_image") return part;
  if (part.type === "image") {
    const source = part.source || {};
    if (source.type === "base64" && source.media_type && source.data) {
      return {
        type: "input_image",
        image_url: `data:${source.media_type};base64,${source.data}`
      };
    }
    return {
      type: "input_image",
      image_url: source.url || part.url
    };
  }
  if (part.type === "image_url") {
    return {
      type: "input_image",
      image_url: typeof part.image_url === "string" ? part.image_url : part.image_url?.url
    };
  }
  if (part.type === "input_file") return part;
  if (part.type === "tool_result") {
    return {
      type: "function_call_output",
      call_id: part.tool_use_id,
      output: typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? {})
    };
  }
  if (part.type === "tool_use") {
    return {
      type: "input_text",
      text: JSON.stringify({ tool_use_id: part.id, name: part.name, input: part.input ?? {} })
    };
  }
  return {
    type: "input_text",
    text: typeof part === "string" ? part : JSON.stringify(part)
  };
}

function normalizeMessage(msg) {
  if (typeof msg === "string") {
    return { role: "user", content: [{ type: "input_text", text: msg }] };
  }

  if (msg?.type === "function_call_output") {
    return {
      type: "function_call_output",
      call_id: msg.call_id,
      output: typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output ?? {})
    };
  }

  if (msg?.role) {
    return { role: msg.role, content: asArray(msg.content).map(part => normalizePart(part, msg.role)) };
  }

  return msg;
}

function flattenInput(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return asArray(input).map(normalizeMessage);
}

function normalizeCustomToolCall(item, { mintMissingIds = false } = {}) {
  return {
    type: "custom_tool_call",
    id: item.id ?? (mintMissingIds ? rid("ctc") : item.id),
    call_id: item.call_id ?? (mintMissingIds ? rid("call") : item.call_id),
    name: item.name,
    input: item.input ?? "",
    status: item.status || "completed"
  };
}

function extractAssistantHistoryItems(upstream, toolSchemas = new Map()) {
  const items = [];
  for (const item of asArray(upstream?.output)) {
    if (item.type === "reasoning") { items.push(deepClone(item)); continue; }
    if (item.type === "message") {
      items.push({
        role: "assistant",
        content: asArray(item.content).map(c => {
          if (c.type === "output_text") {
            return {
              type: "output_text",
              text: c.text ?? "",
              annotations: c.annotations || [],
              logprobs: c.logprobs || []
            };
          }
          return c;
        })
      });
      continue;
    }
    if (item.type === "function_call") {
      items.push({
        type: "function_call",
        id: item.id,
        call_id: item.call_id,
        name: item.name,
        arguments: sanitizeFunctionCallArguments(item.name, item.arguments, toolSchemas),
        status: item.status || "completed"
      });
      continue;
    }
    if (item.type === "custom_tool_call") {
      items.push(normalizeCustomToolCall(item));
    }
  }
  return items;
}

function extractSystemMessage(system) {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return asArray(system)
    .map(part => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeToolResultContent(content) {
  if (typeof content === "string") return content;

  const parts = asArray(content);
  if (!parts.length) return "";

  const textOnly = parts.every(part => typeof part === "string" || part?.type === "text");
  if (textOnly) {
    return parts
      .map(part => typeof part === "string" ? part : part.text ?? "")
      .join("\n");
  }

  return JSON.stringify(content ?? {});
}

function shouldSkipAnthropicHistoryPart(part, role) {
  if (!part || typeof part !== "object" || role !== "assistant") return false;
  return part.type === "thinking" || part.type === "redacted_thinking";
}

function normalizeAnthropicToolUse(part) {
  if (part?.type !== "tool_use") return null;
  return {
    type: "function_call",
    call_id: part.id || rid("call"),
    name: part.name,
    arguments: JSON.stringify(part.input ?? {}),
    status: "completed"
  };
}

function normalizeAnthropicToolResult(part) {
  if (part?.type !== "tool_result") return null;

  const output = normalizeToolResultContent(part.content);
  if (!part.is_error) {
    return {
      type: "function_call_output",
      call_id: part.tool_use_id,
      output
    };
  }

  return {
    type: "function_call_output",
    call_id: part.tool_use_id,
    output: JSON.stringify({
      is_error: true,
      content: output
    })
  };
}

function anthropicMessagesToInput(body) {
  const input = [];
  const system = extractSystemMessage(body.system);
  if (system) {
    input.push({
      role: "system",
      content: [{ type: "input_text", text: system }]
    });
  }

  for (const message of asArray(body.messages)) {
    const parts = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : asArray(message.content);

    let content = [];
    const flushContent = () => {
      if (!content.length) return;
      input.push({ role: message.role, content });
      content = [];
    };

    for (const part of parts) {
      if (shouldSkipAnthropicHistoryPart(part, message.role)) continue;

      const toolUse = message.role === "assistant" ? normalizeAnthropicToolUse(part) : null;
      if (toolUse) {
        flushContent();
        input.push(toolUse);
        continue;
      }

      const toolResult = message.role === "user" ? normalizeAnthropicToolResult(part) : null;
      if (toolResult) {
        flushContent();
        input.push(toolResult);
        continue;
      }

      content.push(normalizePart(part, message.role));
    }

    flushContent();
  }

  return input;
}

function anthropicToolsToOpenAITools(tools) {
  const normalized = asArray(tools).map(tool => {
    if (!tool || typeof tool !== "object") return tool;
    if (tool.input_schema && tool.name) {
      return {
        ...tool,
        type: tool.type || "function",
        parameters: tool.parameters || tool.input_schema
      };
    }
    return tool;
  });
  return translateTools(normalized);
}

function mapAnthropicToolChoice(toolChoice, translatedTools) {
  if (!translatedTools.length || !toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice.type === "auto") return "auto";
  if (toolChoice === "any" || toolChoice.type === "any") return "required";
  if (toolChoice === "none" || toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return simplifyToolChoice({ type: "function", name: toolChoice.name }, translatedTools);
  }
  return "auto";
}

function mapAnthropicThinking(thinking) {
  if (!thinking || thinking.type === "disabled") return undefined;

  let effort = "medium";
  if (thinking.effort) effort = thinking.effort;
  else if (thinking.budget_tokens != null) effort = thinking.budget_tokens >= 8000 ? "high" : thinking.budget_tokens >= 2048 ? "medium" : "low";

  return { effort };
}

function anthropicThinkingRequested(body) {
  return Boolean(body?.thinking && body.thinking.type !== "disabled");
}

function parseJsonObject(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function isBlankString(value) {
  return typeof value === "string" && value.trim().length === 0;
}

function makeToolSchemaMap(tools) {
  const map = new Map();
  for (const tool of asArray(tools)) {
    if (tool?.type === "function" && tool.name && tool.parameters) {
      map.set(tool.name, tool.parameters);
    }
  }
  return map;
}

function sanitizeOptionalEmptyStrings(args, schema) {
  if (!schema || !args || typeof args !== "object") return args;

  if (Array.isArray(args)) {
    if (!schema.items) return args;
    let changed = false;
    const out = args.map(item => {
      const sanitized = sanitizeOptionalEmptyStrings(item, schema.items);
      if (sanitized !== item) changed = true;
      return sanitized;
    });
    return changed ? out : args;
  }

  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return args;

  let changed = false;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const childSchema = properties[key];
    if (value === "" && childSchema && !required.has(key)) {
      delete out[key];
      changed = true;
      continue;
    }

    const sanitized = sanitizeOptionalEmptyStrings(value, childSchema);
    if (sanitized !== value) {
      out[key] = sanitized;
      changed = true;
    }
  }

  return changed ? out : args;
}

function sanitizeSpawnAgentArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;

  const out = { ...args };
  const hasMessage = Object.prototype.hasOwnProperty.call(out, "message");
  const hasItems = Object.prototype.hasOwnProperty.call(out, "items");
  const messageIsBlank = isBlankString(out.message);
  const itemsIsEmpty = Array.isArray(out.items) && out.items.length === 0;

  if (hasMessage && hasItems) {
    if (messageIsBlank) delete out.message;
    if (itemsIsEmpty) delete out.items;
  }

  if (isBlankString(out.model)) delete out.model;
  if (isBlankString(out.reasoning_effort)) delete out.reasoning_effort;
  return out;
}

function sanitizeFunctionCallArguments(name, argsText, toolSchemas = new Map()) {
  const original = argsText || "{}";
  const parsed = parseJsonObject(original, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return original;

  let sanitized = sanitizeOptionalEmptyStrings(parsed, toolSchemas.get(name));
  if (name === "spawn_agent") sanitized = sanitizeSpawnAgentArgs(sanitized);
  return sanitized === parsed ? original : JSON.stringify(sanitized);
}

function sanitizeFunctionCallItem(item, toolSchemas = new Map()) {
  if (item?.type !== "function_call") return item;
  item.arguments = sanitizeFunctionCallArguments(item.name, item.arguments, toolSchemas);
  return item;
}

function sanitizeResponseFunctionCalls(response, toolSchemas = new Map()) {
  if (!response || typeof response !== "object") return response;
  if (Array.isArray(response.output)) {
    for (const item of response.output) sanitizeFunctionCallItem(item, toolSchemas);
  }
  return response;
}

function restoreClientVisibleResponse(response, clientReqBody) {
  if (!response || typeof response !== "object") return response;
  const out = deepClone(response);
  restoreNamespacedFunctionCalls(out, clientReqBody?.tools);
  if (clientReqBody?.tools !== undefined) out.tools = deepClone(clientReqBody.tools);
  if (clientReqBody?.tool_choice !== undefined) out.tool_choice = deepClone(clientReqBody.tool_choice);
  return out;
}

// Single clone+rewrite pass for stream payloads. Replaces the old
// sanitizeResponsesStreamPayload + restoreNamespacedStreamPayload +
// restoreClientVisibleResponse triple that each cloned independently and
// double-restored the namespace mapping. Returns the input unchanged when
// there's nothing to rewrite (no response, no function_call item).
function restoreClientVisibleStreamPayload(payload, clientReqBody, toolSchemas = new Map()) {
  if (!payload || typeof payload !== "object") return payload;
  const hasResponse = payload.response && typeof payload.response === "object";
  const hasFunctionCallItem = payload.item?.type === "function_call" && payload.item?.name !== "spawn_agent";
  if (!hasResponse && !hasFunctionCallItem) return payload;

  const out = deepClone(payload);
  if (hasResponse) {
    sanitizeResponseFunctionCalls(out.response, toolSchemas);
    restoreNamespacedFunctionCalls(out.response, clientReqBody?.tools);
    if (clientReqBody?.tools !== undefined) out.response.tools = deepClone(clientReqBody.tools);
    if (clientReqBody?.tool_choice !== undefined) out.response.tool_choice = deepClone(clientReqBody.tool_choice);
  }
  if (hasFunctionCallItem) {
    sanitizeFunctionCallItem(out.item, toolSchemas);
    const map = collectNamespaceToolMap(clientReqBody?.tools);
    if (map.size) restoreNamespacedFunctionCallItem(out.item, map);
  }
  return out;
}

function collectNamespaceToolMap(tools) {
  const map = new Map();
  for (const tool of asArray(tools)) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type !== "namespace" || !tool.name || !Array.isArray(tool.tools)) continue;
    for (const nested of tool.tools) {
      const nestedTool = unwrapFunctionTool(nested);
      if (!nestedTool?.name) continue;
      map.set(`${tool.name}${nestedTool.name}`, {
        namespace: tool.name,
        name: nestedTool.name
      });
    }
  }
  return map;
}

function restoreNamespacedFunctionCallItem(item, namespaceToolMap) {
  if (!item || item.type !== "function_call" || !item.name || item.namespace) return item;
  const mapped = namespaceToolMap.get(item.name);
  if (!mapped) return item;
  item.namespace = mapped.namespace;
  item.name = mapped.name;
  return item;
}

function restoreNamespacedFunctionCalls(response, tools) {
  const namespaceToolMap = collectNamespaceToolMap(tools);
  if (!namespaceToolMap.size || !response || typeof response !== "object") return response;
  if (Array.isArray(response.output)) {
    for (const item of response.output) restoreNamespacedFunctionCallItem(item, namespaceToolMap);
  }
  return response;
}

function sseBlock(event, data) {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function summarizeReasoning(item) {
  return asArray(item.summary)
    .map(part => part?.text || part?.summary || "")
    .filter(Boolean)
    .join("\n");
}

function mapStopReasonFromOutput(output) {
  return output.some(item => item.type === "function_call") ? "tool_use" : "end_turn";
}

function makeAnthropicUsage(upstream) {
  const usage = upstream.usage || {};
  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0
  };
}

function makeAnthropicMessage(body, upstream, toolSchemas = new Map()) {
  const responseId = upstream.id || rid("msg");
  const output = convertOutput(upstream, toolSchemas);
  const content = [];
  let usedFallbackText = false;

  const thinkingRequested = anthropicThinkingRequested(body);

  for (const item of output) {
    if (item.type === "reasoning") {
      if (!thinkingRequested) continue;
      const thinking = summarizeReasoning(item);
      if (thinking) {
        content.push({
          type: "thinking",
          thinking,
          signature: item.id || rid("sig")
        });
      }
      continue;
    }

    if (item.type === "message") {
      for (const part of asArray(item.content)) {
        if (part.type === "output_text") content.push({ type: "text", text: part.text ?? "" });
      }
      continue;
    }

    if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input: parseJsonObject(item.arguments || "{}", { raw: item.arguments || "{}" })
      });
    }
  }

  if (content.length === 0) {
    usedFallbackText = true;
    content.push({ type: "text", text: "." });
  }

  return {
    id: responseId,
    type: "message",
    role: "assistant",
    model: body.model || upstream.model,
    content,
    stop_reason: usedFallbackText ? "max_tokens" : mapStopReasonFromOutput(output),
    stop_sequence: null,
    usage: makeAnthropicUsage(upstream)
  };
}

function responseFormatToTextFormat(responseFormat) {
  if (!responseFormat) return undefined;
  if (responseFormat.type === "json_schema" && responseFormat.json_schema) {
    return {
      format: {
        type: "json_schema",
        name: responseFormat.json_schema.name,
        schema: responseFormat.json_schema.schema,
        strict: responseFormat.json_schema.strict
      }
    };
  }
  if (responseFormat.type === "json_object") {
    return { format: { type: "json_object" } };
  }
  return undefined;
}

function unwrapFunctionTool(tool) {
  if (tool?.type === "function" && tool.function && typeof tool.function === "object") {
    return {
      type: "function",
      name: tool.function.name,
      description: tool.function.description ?? tool.description,
      parameters: tool.function.parameters ?? tool.parameters
    };
  }
  return tool;
}

function normalizeToolSchema(schema, isTopLevel = true) {
  if (!schema || typeof schema !== "object") return schema;
  const out = deepClone(schema);

  function visit(node, topLevel) {
    if (!node || typeof node !== "object") return;
    if (node.type === "object" || node.properties || node.additionalProperties) {
      const properties = node.properties && typeof node.properties === "object" ? node.properties : undefined;
      const propertyNames = properties ? Object.keys(properties) : [];
      if (!topLevel && propertyNames.length === 0 && node.additionalProperties === undefined) {
        node.additionalProperties = true;
      }
      if (properties) {
        for (const value of Object.values(properties)) visit(value, false);
      }
      if (node.additionalProperties && typeof node.additionalProperties === "object") {
        visit(node.additionalProperties, false);
      }
    }
    for (const key of ["items", "contains", "not", "if", "then", "else"]) {
      if (node[key]) visit(node[key], false);
    }
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      if (Array.isArray(node[key])) {
        for (const child of node[key]) visit(child, false);
      }
    }
  }

  visit(out, isTopLevel);
  return out;
}

function isStandardFunctionTool(tool) {
  return tool?.type === "function" && typeof tool?.name === "string" && !tool?.tools;
}

function normalizeFunctionTool(tool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: normalizeToolSchema(tool.parameters || {
      type: "object",
      properties: {},
      additionalProperties: false
    })
  };
}

function normalizeMcpTool(tool) {
  const out = { ...tool };
  if (out.server_label && !out.server_label.match(/^[A-Za-z0-9_-]+$/)) {
    out.server_label = out.server_label.replace(/[^A-Za-z0-9_-]+/g, "_");
  }
  return out;
}

function normalizeNamespaceTool(namespace, tool) {
  const nested = unwrapFunctionTool(tool);
  if (!namespace?.name || !nested?.name) return null;
  const normalized = normalizeFunctionTool({
    ...nested,
    type: "function",
    name: `${namespace.name}${nested.name}`,
    description: nested.description || `${namespace.name}${nested.name}`
  });
  // Preserve pre-namespace original name so simplifyToolChoice can match
  // a tool_choice that names the child tool without the namespace prefix.
  normalized._originalName = nested.name;
  return normalized;
}

function simplifyToolChoice(toolChoice, translatedTools) {
  if (!translatedTools?.length) return undefined;
  if (!toolChoice || toolChoice === "auto") return "auto";
  if (toolChoice === "required") return "required";
  if (toolChoice === "none") return "none";

  if (typeof toolChoice === "object" && (toolChoice.type === "function" || toolChoice.type === "custom")) {
    const requestedName = toolChoice.name || toolChoice.function?.name;
    // Match by translated name (exact) or by pre-namespace original name stored in _originalName.
    const translated = translatedTools.find(t => t.name === requestedName || t._originalName === requestedName);
    return translated ? { type: translated.type === "custom" ? "custom" : "function", name: translated.name } : "auto";
  }

  return "auto";
}

function translateTools(tools) {
  const translated = [];
  const seen = new Set();

  function pushTool(tool) {
    if (!tool || typeof tool !== "object") return;
    const key = tool.type === "function" || tool.type === "custom"
      ? `${tool.type}:${tool.name}`
      : `${tool.type}:${tool.server_label || tool.name || JSON.stringify(tool)}`;
    if (seen.has(key)) return;
    seen.add(key);
    translated.push(tool);
  }

  // Translate client-declared tools to upstream-compatible shape. Bridge no
  // longer fabricates synthetic capability tools (workspace_action / web_lookup
  // / code_execution / computer_action / image_action) — those were legacy
  // fallbacks for clients that sent untyped MCP entries, and never matched
  // anything OpenAI actually documents. Untyped tools are forwarded as bare
  // function tools; clients sending fully shapeless entries get a no-op.
  function visit(tool) {
    if (!tool || typeof tool !== "object") return;
    tool = unwrapFunctionTool(tool);

    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        pushTool(normalizeNamespaceTool(tool, nested));
      }
      return;
    }

    if (tool.type === "mcp" || tool.type === "remote_mcp") {
      const nestedTools = asArray(tool.tools);
      if (nestedTools.length) {
        for (const nested of nestedTools) visit(nested);
        return;
      }
      if (tool.server_url || tool.serverUrl || tool.url) {
        pushTool(normalizeMcpTool(tool));
      }
      return;
    }

    if (isStandardFunctionTool(tool)) {
      pushTool(normalizeFunctionTool(tool));
      return;
    }

    if (tool.type === "custom" && tool.name) {
      pushTool(tool);
      return;
    }

    if (Array.isArray(tool.tools)) {
      for (const nested of tool.tools) visit(nested);
      return;
    }

    if (tool.type || tool.name) {
      pushTool(normalizeFunctionTool({
        type: "function",
        name: tool.name || tool.type,
        description: tool.description || `Forwarded ${tool.type || "tool"}`,
        parameters: tool.parameters || {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }));
    }
  }

  for (const tool of asArray(tools)) visit(tool);
  return translated;
}

function mergeHistory(previousResponseId, input, scope) {
  const incoming = flattenInput(input);
  if (!previousResponseId) return incoming;
  const prev = ownedResponse(store, scope, previousResponseId, STORE_TTL_MS);
  return [...deepClone(prev.history), ...incoming];
}

function extractOutputText(upstream) {
  const texts = [];
  for (const item of asArray(upstream.output)) {
    if (item.type !== "message") continue;
    for (const c of asArray(item.content)) {
      if (c.type === "output_text" && c.text) texts.push(c.text);
    }
  }
  return texts.join("\n");
}

function convertOutput(upstream, toolSchemas = new Map()) {
  const output = [];
  for (const item of asArray(upstream.output)) {
    if (item.type === "reasoning") {
      output.push({
        id: item.id || rid("rs"),
        type: "reasoning",
        summary: item.summary || []
      });
      continue;
    }

    if (item.type === "function_call") {
      output.push({
        type: "function_call",
        id: item.id || rid("fc"),
        call_id: item.call_id || rid("call"),
        name: item.name,
        arguments: sanitizeFunctionCallArguments(item.name, item.arguments, toolSchemas),
        status: item.status || "completed"
      });
      continue;
    }

    if (item.type === "custom_tool_call") {
      output.push(normalizeCustomToolCall(item, { mintMissingIds: true }));
      continue;
    }

    if (item.type === "message") {
      output.push({
        id: item.id || rid("msg"),
        type: "message",
        role: item.role || "assistant",
        status: item.status || "completed",
        phase: item.phase,
        content: asArray(item.content).map(c => {
          if (c.type === "output_text") {
            return {
              type: "output_text",
              text: c.text ?? "",
              annotations: c.annotations || [],
              logprobs: c.logprobs || []
            };
          }
          return c;
        })
      });
      continue;
    }
  }
  return output;
}

function makeOpenAIResponse(reqBody, upstream, toolSchemas = new Map()) {
  const response = deepClone(upstream ?? {});

  response.id ??= rid("resp");
  response.object ??= "response";
  response.created_at ??= now();
  response.model ??= reqBody.model;
  response.instructions ??= reqBody.instructions ?? null;
  response.max_output_tokens ??= reqBody.max_output_tokens ?? null;
  response.parallel_tool_calls ??= true;
  response.previous_response_id ??= reqBody.previous_response_id ?? null;
  response.reasoning ??= { effort: "none" };
  response.store ??= true;
  response.temperature ??= reqBody.temperature ?? 1;
  response.text ??= { format: { type: "text" }, verbosity: "medium" };
  response.tool_choice ??= reqBody.tool_choice ?? "auto";
  response.tools = reqBody.tools !== undefined ? deepClone(reqBody.tools) : response.tools;
  response.top_p ??= reqBody.top_p ?? 1;
  response.truncation ??= "disabled";
  response.usage ??= null;
  response.metadata ??= reqBody.metadata ?? {};
  response.user ??= reqBody.user ?? null;
  restoreNamespacedFunctionCalls(response, reqBody.tools);
  sanitizeResponseFunctionCalls(response, toolSchemas);

  if (response.output_text == null) {
    response.output_text = extractOutputText(response);
  }

  return response;
}

function openAIChatMessagesToInput(messages) {
  const input = [];
  for (const msg of asArray(messages)) {
    if (!msg) continue;

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "")
      });
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      if (msg.content) {
        input.push({
          role: "assistant",
          content: typeof msg.content === "string"
            ? [{ type: "output_text", text: msg.content, annotations: [], logprobs: [] }]
            : asArray(msg.content).map(part => normalizePart(part, "assistant"))
        });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments || "{}",
          status: "completed"
        });
      }
      continue;
    }

    input.push({
      role: msg.role,
      content: typeof msg.content === "string"
        ? [msg.role === "assistant"
          ? { type: "output_text", text: msg.content, annotations: [], logprobs: [] }
          : { type: "input_text", text: msg.content }]
        : asArray(msg.content).map(part => normalizePart(part, msg.role))
    });
  }
  return input;
}

function chatCompletionChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: now(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

function getSessionIdForConversation(conversationKey) {
  if (!conversationSessions.has(conversationKey)) {
    conversationSessions.set(conversationKey, crypto.randomUUID());
  }
  touchConversation(conversationKey);
  return conversationSessions.get(conversationKey);
}

function saveResponse(id, history, upstream, openaiResp, conversationKey, toolSchemas = new Map()) {
  if (provider.kind === "deepseek") return;
  const baseHistory = Array.isArray(history) ? history : flattenInput(history);
  const assistantItems = extractAssistantHistoryItems(upstream, toolSchemas);
  store.set(responseKey(conversationKey, id), {
    history: deepClone([...baseHistory, ...assistantItems]),
    upstream: deepClone(upstream),
    response: deepClone(openaiResp),
    conversationKey,
    createdAt: Date.now()
  });
  touchConversation(conversationKey);
}


function withDetailedReasoningSummary(body) {
  const out = { ...(body || {}) };
  if (!out.reasoning || typeof out.reasoning !== "object" || Array.isArray(out.reasoning)) {
    return out;
  }

  out.reasoning = { ...out.reasoning, summary: "detailed" };
  return out;
}

function modelHubUrl(path = "responses") {
  return provider.url(path);
}

function extractSessionId(body, headers) {
  if (body && typeof body.session_id === "string" && body.session_id) return body.session_id;
  if (body?.metadata && typeof body.metadata.session_id === "string" && body.metadata.session_id) {
    return body.metadata.session_id;
  }
  if (body?.extra) {
    const extraObj = typeof body.extra === "string" ? parseJsonObject(body.extra, null) : body.extra;
    if (extraObj && typeof extraObj.session_id === "string" && extraObj.session_id) {
      return extraObj.session_id;
    }
  }
  const hdr = headers?.["x-session-id"];
  if (typeof hdr === "string" && hdr) return hdr;
  return null;
}

async function forwardCompact(req, reply, apiPath) {
  if (!provider.compact) return reply.code(400).send({error: {code: "REMOTE_COMPACTION_UNSUPPORTED"}});
  const incoming = req.body || {};
  const reqLog = initPayloadLog(req, apiPath.replace(/\W+/g, "_"), incoming);
  const body = { ...incoming };

  const conversationKey = req.bridgeScope;
  if (body.previous_response_id) {
    ownedResponse(store, conversationKey, body.previous_response_id, STORE_TTL_MS);
  }
  const sessionId = getSessionIdForConversation(conversationKey);

  delete body.session_id;
  delete body.extra;
  if (Array.isArray(body.input)) {
    body.input = portableNativeInput(body.input, req.headers['x-exp-legacy-reasoning']);
  }
  if (body.metadata && typeof body.metadata === "object") {
    const md = { ...body.metadata };
    delete md.session_id;
    if (Object.keys(md).length === 0) delete body.metadata;
    else body.metadata = md;
  }

  body.model = MODELHUB_MODEL;
  body.max_output_tokens = pickMaxOutputTokens(body);
  delete body.max_tokens;
  delete body.max_completion_tokens;

  const upstreamBody = withDetailedReasoningSummary(body);
  const url = modelHubUrl(apiPath);
  app.log.debug({ apiPath, sessionId }, "forwarding compact to modelhub");
  appendPayloadLog(reqLog, "modelhub_input", { session_id: sessionId, path: apiPath, body: upstreamBody });

  const logId = freshLogId();
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: modelHubHeaders(sessionId, logId),
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify(withModelHubEnvelope(upstreamBody, sessionId, logId))
    });
  } catch (err) {
    const message = err?.message || "upstream fetch failed";
    app.log.error({ err }, "modelhub compact fetch failed");
    appendPayloadLog(reqLog, "modelhub_output", { status: 502, error: message });
    reply.code(502);
    return { error: { type: "upstream_error", message } };
  }

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  app.log.debug({ upstreamStatus: resp.status, upstreamResponse: json }, "modelhub compact response");
  appendPayloadLog(reqLog, "modelhub_output", { status: resp.status, upstream_headers: pickRelevantHeaders(resp.headers), body: json });
  reply.code(resp.status);
  return json;
}

// Fresh per-request id so traces in ModelHub are distinguishable instead of
// every request sharing one process-level logid.
function freshLogId() {
  return crypto.randomUUID();
}

function modelHubHeaders(sessionId, logId = freshLogId()) {
  return provider.headers(sessionId, logId);
}

function withModelHubEnvelope(upstreamBody, sessionId, logId = freshLogId()) {
  return provider.body(upstreamBody, sessionId, logId);
}

function pickRelevantHeaders(headers) {
  if (!headers) return undefined;
  const out = {};
  const exact = new Set(["x-request-id", "x-tt-logid", "x-trace-id", "retry-after", "content-type"]);
  const matchExtra = key => /^x-(ratelimit|quota|tt-)/.test(key) || /^ratelimit-/.test(key);
  const visit = (k, v) => {
    const lk = String(k).toLowerCase();
    if (exact.has(lk) || matchExtra(lk)) out[lk] = v;
  };
  if (typeof headers.forEach === "function") {
    headers.forEach((v, k) => visit(k, v));
  } else {
    for (const [k, v] of Object.entries(headers)) visit(k, v);
  }
  return Object.keys(out).length ? out : undefined;
}

async function callModelHub(body, sessionId, reqLog = null, attempt = 0) {
  const { clientRequestBody: _clientRequestBody, ...bodyForUpstream } = body;
  const upstreamBody = withDetailedReasoningSummary(bodyForUpstream);
  const startedAt = Date.now();
  app.log.debug({ upstreamBody }, "forwarding request to modelhub");
  appendPayloadLog(reqLog, "modelhub_input", { attempt, model: body.model, session_id: sessionId, path: "responses", body: upstreamBody });

  const logId = freshLogId();
  let resp;
  try {
    resp = await fetch(modelHubUrl(), {
      method: "POST",
      headers: modelHubHeaders(sessionId, logId),
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify(withModelHubEnvelope(upstreamBody, sessionId, logId))
    });
  } catch (err) {
    const message = err?.message || "upstream fetch failed";
    app.log.error({ err }, "modelhub fetch failed");
    appendPayloadLog(reqLog, "modelhub_output", { attempt, model: body.model, status: 502, error: message, duration_ms: Date.now() - startedAt });
    return {
      status: 502,
      ok: false,
      json: { error: { type: "upstream_error", message } }
    };
  }

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  app.log.debug({ upstreamStatus: resp.status, upstreamResponse: json }, "modelhub response");
  appendPayloadLog(reqLog, "modelhub_output", {
    attempt,
    model: body.model,
    status: resp.status,
    upstream_headers: pickRelevantHeaders(resp.headers),
    body: json,
    duration_ms: Date.now() - startedAt
  });
  return { status: resp.status, ok: resp.ok, json };
}

async function streamModelHub(body, sessionId, onEvent, reqLog = null, attempt = 0) {
  const { clientRequestBody: _clientRequestBody, ...bodyForUpstream } = body;
  const upstreamBody = withDetailedReasoningSummary({ ...bodyForUpstream, stream: true });
  app.log.debug({ upstreamBody, sessionId }, "streaming request to modelhub");
  appendPayloadLog(reqLog, "modelhub_input", { attempt, model: body.model, session_id: sessionId, path: "responses", body: upstreamBody });
  const startedAt = Date.now();
  const eventCounts = {};

  const logId = freshLogId();
  let resp;
  try {
    resp = await fetch(modelHubUrl(), {
      method: "POST",
      headers: modelHubHeaders(sessionId, logId),
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify(withModelHubEnvelope(upstreamBody, sessionId, logId))
    });
  } catch (err) {
    const message = err?.message || "upstream fetch failed";
    app.log.error({ err }, "modelhub stream fetch failed");
    appendPayloadLog(reqLog, "modelhub_output", { attempt, model: body.model, status: 502, error: message, duration_ms: Date.now() - startedAt });
    return {
      resp: { ok: false, status: 502 },
      errorText: message,
      errorJson: { error: { type: "upstream_error", message } },
      stats: { eventCounts, totalBytes: 0, durationMs: Date.now() - startedAt }
    };
  }

  if (!resp.ok || !resp.body) {
    const text = await resp.text();
    appendPayloadLog(reqLog, "modelhub_output", {
      attempt,
      model: body.model,
      status: resp.status,
      upstream_headers: pickRelevantHeaders(resp.headers),
      body: parseJsonObject(text, { raw: text }),
      duration_ms: Date.now() - startedAt
    });
    return { resp, errorText: text, errorJson: parseJsonObject(text, null), stats: { eventCounts, totalBytes: 0, durationMs: Date.now() - startedAt } };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let totalBytes = 0;
  let firstByteAt = 0;

  function flushBlocks(blocks) {
    for (const block of blocks) {
      const dataLines = block
        .split("\n")
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart());
      if (!dataLines.length) continue;
      const data = dataLines.join("\n");
      if (data === "[DONE]") {
        eventCounts["[DONE]"] = (eventCounts["[DONE]"] || 0) + 1;
        onEvent({ done: true, raw: block });
        continue;
      }
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        const t = payload?.type || "(no-type)";
        eventCounts[t] = (eventCounts[t] || 0) + 1;
        onEvent({ payload, raw: block });
      } catch {
        eventCounts["(parse-error)"] = (eventCounts["(parse-error)"] || 0) + 1;
        onEvent({ rawData: data, raw: block });
      }
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstByteAt && value?.length) firstByteAt = Date.now();
      if (value?.length) totalBytes += value.length;
      sseBuffer += decoder.decode(value, { stream: true });
      sseBuffer = sseBuffer.replace(/\r\n/g, "\n");
      if (sseBuffer.length > 4_000_000 || totalBytes > 32_000_000) throw new Error("UPSTREAM_STREAM_LIMIT");
      const blocks = sseBuffer.split("\n\n");
      sseBuffer = blocks.pop() || "";
      flushBlocks(blocks);
    }

    sseBuffer += decoder.decode();
    flushBlocks(sseBuffer.split("\n\n").filter(Boolean));
  } catch (err) {
    const message = err?.message || "upstream stream read failed";
    app.log.error({ err, eventCounts, totalBytes }, "modelhub stream read failed");
    appendPayloadLog(reqLog, "modelhub_output", {
      attempt,
      model: body.model,
      status: 502,
      error: message,
      event_counts: eventCounts,
      total_bytes: totalBytes,
      duration_ms: Date.now() - startedAt
    });
    return {
      resp: { ok: false, status: 502 },
      errorText: message,
      errorJson: { error: { type: "upstream_error", message } },
      stats: { eventCounts, totalBytes, durationMs: Date.now() - startedAt }
    };
  }

  const durationMs = Date.now() - startedAt;
  app.log.debug({
    upstreamStatus: resp.status,
    eventCounts,
    totalBytes,
    firstByteMs: firstByteAt ? firstByteAt - startedAt : null,
    durationMs
  }, "modelhub stream finished");

  return {
    resp,
    headers: pickRelevantHeaders(resp.headers),
    stats: { eventCounts, totalBytes, firstByteMs: firstByteAt ? firstByteAt - startedAt : null, durationMs }
  };
}

const CAPACITY_MAX_RETRIES = 2;
const CAPACITY_RETRY_DELAY_MS = 500;

function isRetryableStreamFailure(payload) {
  if (!payload) return false;
  const err = payload.error || payload.response?.error || payload;
  return err?.code === "no_capacity" || err?.type === "too_many_requests";
}

async function streamModelHubWithRetry(body, sessionId, onEvent, reqLog, attempt) {
  for (let retry = 0; retry <= CAPACITY_MAX_RETRIES; retry++) {
    const buffer = [];
    let committed = false;

    const result = await streamModelHub(body, sessionId, (event) => {
      if (committed) { onEvent(event); return; }
      const t = event.payload?.type;
      if (t === UPSTREAM_EVENT.OUTPUT_TEXT_DELTA ||
          t === UPSTREAM_EVENT.FUNCTION_CALL_ARGS_DELTA ||
          t === "response.reasoning_text.delta" ||
          t === UPSTREAM_EVENT.REASONING_DELTA ||
          t === UPSTREAM_EVENT.REASONING_SUMMARY_TEXT_DELTA) {
        committed = true;
        for (const e of buffer) onEvent(e);
        buffer.length = 0;
        onEvent(event);
        return;
      }
      buffer.push(event);
    }, reqLog, attempt);

    if (!committed && retry < CAPACITY_MAX_RETRIES) {
      let retryable = false;
      if (!result.resp.ok && result.errorJson) {
        retryable = isRetryableStreamFailure(result.errorJson);
      }
      if (!retryable) {
        for (const e of buffer) {
          const t = e.payload?.type;
          if ((t === UPSTREAM_EVENT.FAILED || t === UPSTREAM_EVENT.ERROR) && isRetryableStreamFailure(e.payload)) {
            retryable = true;
            break;
          }
        }
      }
      if (retryable) {
        app.log.warn({ retry: retry + 1, maxRetries: CAPACITY_MAX_RETRIES, model: body.model }, "no_capacity, retrying stream");
        if (CAPACITY_RETRY_DELAY_MS > 0) await new Promise(r => setTimeout(r, CAPACITY_RETRY_DELAY_MS));
        continue;
      }
    }

    if (!committed) {
      for (const e of buffer) onEvent(e);
    }
    return result;
  }
}

function makeStreamErrorPayload(status, errorText, errorJson) {
  const message = errorJson?.error?.message || errorJson?.message || errorText || `Upstream error ${status}`;
  return {
    type: "error",
    error: {
      type: errorJson?.error?.type || errorJson?.type || "api_error",
      message
    }
  };
}

const UPSTREAM_EVENT = {
  CREATED: "response.created",
  OUTPUT_ITEM_ADDED: "response.output_item.added",
  OUTPUT_ITEM_DONE: "response.output_item.done",
  OUTPUT_TEXT_DELTA: "response.output_text.delta",
  REASONING_DELTA: "response.reasoning.delta",
  REASONING_SUMMARY_TEXT_DELTA: "response.reasoning_summary_text.delta",
  FUNCTION_CALL_ARGS_DELTA: "response.function_call_arguments.delta",
  COMPLETED: "response.completed",
  FAILED: "response.failed",
  INCOMPLETE: "response.incomplete",
  ERROR: "error"
};

function createStreamAccumulators() {
  return {
    fullText: "",
    reasoningText: "",
    reasoningByIndex: new Map(),
    toolCallArgsByIndex: new Map(),
    completedResponse: null,
    upstreamFailure: null
  };
}

function applyStreamPayloadToAccumulators(payload, acc) {
  if (!payload?.type) return;
  switch (payload.type) {
    case UPSTREAM_EVENT.OUTPUT_TEXT_DELTA:
      acc.fullText += payload.delta || "";
      return;
    case "response.reasoning_text.delta":
    case UPSTREAM_EVENT.REASONING_DELTA:
    case UPSTREAM_EVENT.REASONING_SUMMARY_TEXT_DELTA: {
      const d = payload.delta || "";
      acc.reasoningText += d;
      const k = payload.output_index ?? 0;
      acc.reasoningByIndex.set(k, (acc.reasoningByIndex.get(k) || "") + d);
      return;
    }
    case UPSTREAM_EVENT.FUNCTION_CALL_ARGS_DELTA: {
      const k = payload.output_index ?? 0;
      acc.toolCallArgsByIndex.set(k, (acc.toolCallArgsByIndex.get(k) || "") + (payload.delta || ""));
      return;
    }
    case UPSTREAM_EVENT.COMPLETED:
      acc.completedResponse = payload.response || null;
      return;
    case UPSTREAM_EVENT.INCOMPLETE:
    case UPSTREAM_EVENT.FAILED:
    case UPSTREAM_EVENT.ERROR:
      acc.upstreamFailure = payload;
      return;
  }
}

function appendStreamCompletionLog({ reqLog, api, attempt, model, resp, headers, stats, acc }) {
  appendPayloadLog(reqLog, "modelhub_output", {
    attempt,
    model,
    status: resp.status,
    stream: true,
    api,
    upstream_headers: headers,
    body: acc.completedResponse,
    output_text: acc.fullText,
    reasoning_text: acc.reasoningText || undefined,
    reasoning_by_index: acc.reasoningByIndex.size ? Object.fromEntries(acc.reasoningByIndex) : undefined,
    tool_call_arguments: acc.toolCallArgsByIndex.size ? Object.fromEntries(acc.toolCallArgsByIndex) : undefined,
    event_counts: stats?.eventCounts,
    total_bytes: stats?.totalBytes,
    first_byte_ms: stats?.firstByteMs,
    duration_ms: stats?.durationMs
  });
}

// Shared single-model execution for all three streaming endpoints. Each endpoint
// supplies hooks that handle its own SSE protocol:
//   - initState(ctx)        — per-attempt mutable state (Sets, Maps, flags)
//   - makeOnEvent(ctx, st)  — returns the streamModelHub callback
//   - onUpstreamError(ctx, st, result) — upstream error emission
//   - onAttemptSuccess(ctx, st, result) — terminal events + appendStreamCompletionLog + end
// ctx: { attempt, modelForAttempt, bodyForAttempt, acc, ensureSseHeaders, isHeadersSent, reply, sessionId, reqLog, apiLabel }
async function runModelHubStream({ body, reply, sessionId, reqLog, apiLabel, hooks }) {
  let headersSent = false;
  function ensureSseHeaders() {
    if (!headersSent) { setSseHeaders(reply); headersSent = true; }
  }
  const isHeadersSent = () => headersSent;

  const attempt = 0;
  const modelForAttempt = MODELHUB_MODEL;
  const bodyForAttempt = { ...body, model: modelForAttempt };
  const acc = createStreamAccumulators();
  const ctx = { attempt, modelForAttempt, bodyForAttempt, acc, ensureSseHeaders, isHeadersSent, reply, sessionId, reqLog, apiLabel };
  const state = hooks.initState ? hooks.initState(ctx) : {};
  const handler = hooks.makeOnEvent(ctx, state);
  let terminal = false;
  const onEvent = event => {
    if (["response.completed", "response.incomplete", "response.failed"].includes(event.payload?.type)) terminal = true;
    handler(event);
  };

  const { resp, errorText, errorJson, headers, stats } = await streamModelHubWithRetry(bodyForAttempt, sessionId, onEvent, reqLog, attempt);
  const result = { resp, errorText, errorJson, headers, stats };

  if (!resp.ok) {
    return hooks.onUpstreamError(ctx, state, result);
  }
  if (!terminal) return hooks.onUpstreamError(ctx, state, {
    resp: {status: 502}, errorText: "UPSTREAM_STREAM_INTERRUPTED", errorJson: {error: {type: "upstream_error", message: "Stream ended without a terminal response"}}
  });
  return hooks.onAttemptSuccess(ctx, state, result);
}

async function proxyModelHubStream(body, reply, sessionId, conversationKey, reqLog = null, toolSchemas = new Map()) {
  return runModelHubStream({
    body, reply, sessionId, reqLog, apiLabel: "responses",
    hooks: {
      initState: () => ({
        latestResponse: null,
        sawOutputItem: false,
        spawnAgentOutputIndexes: new Set(),
        bufferedSpawnAgentArgs: new Map()
      }),
      makeOnEvent: (ctx, st) => ({ payload, done, raw }) => {
        ctx.ensureSseHeaders();
        if (done) return;
        if (!payload) {
          reply.raw.write(`${raw}\n\n`);
          return;
        }

        const outPayload = restoreClientVisibleStreamPayload(payload, body.clientRequestBody, toolSchemas);
        if (outPayload?.response) st.latestResponse = outPayload.response;
        if (outPayload?.type === UPSTREAM_EVENT.OUTPUT_ITEM_ADDED) {
          st.sawOutputItem = true;
          if (outPayload.output_index != null && outPayload.item?.type === "function_call") {
            if (outPayload.item?.name === "spawn_agent") st.spawnAgentOutputIndexes.add(outPayload.output_index);
          }
        }
        applyStreamPayloadToAccumulators(outPayload, ctx.acc);
        if (outPayload?.type === UPSTREAM_EVENT.ERROR || outPayload?.type === UPSTREAM_EVENT.FAILED) {
          app.log.warn({ upstreamFailure: payload }, "upstream stream returned failure event");
        }

        if (outPayload?.type === UPSTREAM_EVENT.FUNCTION_CALL_ARGS_DELTA && st.spawnAgentOutputIndexes.has(outPayload.output_index)) {
          st.bufferedSpawnAgentArgs.set(outPayload.output_index, (st.bufferedSpawnAgentArgs.get(outPayload.output_index) || "") + (outPayload.delta || ""));
          return;
        }

        if (outPayload?.type === UPSTREAM_EVENT.OUTPUT_ITEM_DONE && st.spawnAgentOutputIndexes.has(outPayload.output_index)) {
          const originalArgs = st.bufferedSpawnAgentArgs.get(outPayload.output_index) || outPayload.item?.arguments || "{}";
          const sanitizedArgs = sanitizeFunctionCallArguments(outPayload.item?.name || "spawn_agent", originalArgs);
          if (sanitizedArgs) {
            reply.raw.write(sseBlock(UPSTREAM_EVENT.FUNCTION_CALL_ARGS_DELTA, {
              type: UPSTREAM_EVENT.FUNCTION_CALL_ARGS_DELTA,
              output_index: outPayload.output_index,
              item_id: outPayload.item_id || outPayload.item?.id,
              delta: sanitizedArgs
            }));
          }
          if (outPayload.item?.type === "function_call") outPayload.item.arguments = sanitizedArgs;
          st.bufferedSpawnAgentArgs.delete(outPayload.output_index);
        }
        reply.raw.write(sseBlock(outPayload?.type, outPayload));
      },
      onUpstreamError: (ctx, st, { resp, errorText, errorJson }) => {
        app.log.warn({status: resp.status, model: ctx.modelForAttempt,
          error: errorJson?.error?.type || 'upstream_error'}, 'responses upstream rejected request');
        if (!ctx.isHeadersSent()) {
          return reply.code(resp.status).send({error: {
            type: errorJson?.error?.type || 'upstream_error',
            code: errorJson?.error?.code || null,
            message: errorJson?.error?.message || errorText || `Upstream HTTP ${resp.status}`
          }});
        }
        ctx.ensureSseHeaders();
        const error = makeStreamErrorPayload(resp.status, errorText, errorJson).error;
        sse(reply, "error", {type:'error', code:error.type, message:error.message, param:null});
        reply.raw.end();
        return reply;
      },
      onAttemptSuccess: (ctx, st, { resp, headers, stats }) => {
        const { acc, attempt, modelForAttempt, bodyForAttempt } = ctx;
        if (!acc.completedResponse && acc.upstreamFailure) {
          const upstreamFailure = acc.upstreamFailure;
          const errMsg =
            upstreamFailure?.error?.message ||
            upstreamFailure?.response?.error?.message ||
            upstreamFailure?.message ||
            "upstream returned response.failed";
          const errType =
            upstreamFailure?.error?.type ||
            upstreamFailure?.response?.error?.type ||
            "upstream_error";
          sse(reply, "error", { type: "error", error: { type: errType, message: errMsg } });
          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return reply;
        }

        if (!acc.completedResponse) {
          const output = st.latestResponse?.output || (!st.sawOutputItem && acc.fullText ? [{
            id: rid("msg"),
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: acc.fullText, annotations: [], logprobs: [] }]
          }] : []);

          acc.completedResponse = makeOpenAIResponse(bodyForAttempt, {
            ...st.latestResponse,
            id: st.latestResponse?.id || rid("resp"),
            object: "response",
            created_at: st.latestResponse?.created_at || now(),
            status: "completed",
            model: st.latestResponse?.model || modelForAttempt,
            output,
            output_text: st.latestResponse?.output_text ?? acc.fullText
          }, toolSchemas);

          sse(reply, "response.completed", {
            type: "response.completed",
            response: acc.completedResponse
          });
        }

        if (acc.completedResponse?.id) {
          if (acc.fullText && !acc.completedResponse.output_text) acc.completedResponse.output_text = acc.fullText;
          saveResponse(acc.completedResponse.id, bodyForAttempt.input, acc.completedResponse, acc.completedResponse, conversationKey, toolSchemas);
        }

        appendStreamCompletionLog({ reqLog, api: "responses", attempt, model: modelForAttempt, resp, headers, stats, acc });

        app.log.debug({
          model: modelForAttempt,
          completedId: acc.completedResponse?.id,
          completedStatus: acc.completedResponse?.status,
          outputItems: acc.completedResponse?.output?.length || 0,
          outputTypes: (acc.completedResponse?.output || []).map(o => o?.type),
          finishReason: acc.completedResponse?.output?.[0]?.content?.[0]?.finish_reason,
          fullTextLen: acc.fullText.length,
          fullTextHead: acc.fullText.slice(0, 200),
          sawOutputItem: st.sawOutputItem,
          usage: acc.completedResponse?.usage
        }, "stream response summary");

        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      }
    }
  });
}

function setSseHeaders(reply) {
  for (const [name, value] of Object.entries(SSE_HEADERS)) {
    reply.raw.setHeader(name, value);
  }
  if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();
}

function sse(reply, event, data) {
  reply.raw.write(sseBlock(event, data));
}

// Clients (Claude Code, Codex, etc.) probe the endpoint with max_tokens=1 as a
// cheap "are you alive" health check. There's no useful upstream call to make
// for these — answer with an empty but well-formed response so the probe
// succeeds without consuming ModelHub quota.
function isProbeRequest(body) {
  return isProbeMaxTokens(body);
}

// Translate client tools and pre-build the schema map together — they're
// always used as a pair (translation for upstream, schema map for sanitize).
function translateAndIndexTools(tools, translator = translateTools) {
  const translatedTools = translator(tools);
  const toolSchemas = makeToolSchemaMap(translatedTools);
  return { translatedTools, toolSchemas };
}

// Drop keys whose value is undefined in place; returns the same object.
function dropUndefined(obj) {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

// Build the upstream Responses-API body shared by the three endpoint handlers.
// Endpoint-specific fields (instructions / text / reasoning / clientRequestBody)
// can be passed via `extra` and are merged after the common fields.
function buildUpstreamRequest({ input, body, translatedTools, toolChoiceFn, extra = {} }) {
  return dropUndefined({
    model: MODELHUB_MODEL,
    input,
    stream: false,
    temperature: body.temperature,
    top_p: body.top_p,
    max_output_tokens: pickMaxOutputTokens(body),
    tools: translatedTools,
    tool_choice: toolChoiceFn(body.tool_choice, translatedTools),
    ...extra
  });
}

// ModelHub returns Responses-style usage (input_tokens/output_tokens). The
// OpenAI Chat Completions contract uses prompt_tokens/completion_tokens, so
// remap for that endpoint only.
function toChatCompletionsUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? (prompt + completion);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    ...(usage.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}),
    ...(usage.output_tokens_details ? { completion_tokens_details: usage.output_tokens_details } : {})
  };
}

function probeChatCompletion(body, reply) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = now();
  const model = body.model || "probe";
  if (body.stream) {
    setSseHeaders(reply);
    const baseChunk = { id, object: "chat.completion.chunk", created, model };
    reply.raw.write(`data: ${JSON.stringify({ ...baseChunk, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
    reply.raw.write(`data: ${JSON.stringify({ ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`);
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return reply;
  }
  return {
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

function probeAnthropicMessages(body, reply) {
  const id = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const model = body.model || "probe";
  if (body.stream) {
    setSseHeaders(reply);
    const w = (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    w("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    w("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    w("content_block_stop", { type: "content_block_stop", index: 0 });
    w("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 1 } });
    w("message_stop", { type: "message_stop" });
    reply.raw.end();
    return reply;
  }
  return {
    id, type: "message", role: "assistant", model,
    content: [{ type: "text", text: "" }],
    stop_reason: "max_tokens", stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 1 }
  };
}

function probeOpenAIResponses(body, reply) {
  const id = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const created = now();
  const model = body.model || "probe";
  const response = {
    id, object: "response", created_at: created, status: "completed",
    model, output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    max_output_tokens: 1
  };
  if (body.stream) {
    setSseHeaders(reply);
    reply.raw.write(sseBlock("response.created", { type: "response.created", response }));
    reply.raw.write(sseBlock("response.completed", { type: "response.completed", response }));
    reply.raw.end();
    return reply;
  }
  return response;
}

app.addHook("preHandler", verifyClientAuth);

app.get("/health", async () => ({ ok: true, isolation: "signed-conversation-v1", instance: process.env.BRIDGE_INSTANCE_ID }));

app.get("/v1/models", async req => {
  if (hasAnthropicApiKey(req.headers)) return buildAnthropicModelsResponse();
  return buildOpenAIModelsResponse();
});

app.post("/v1/responses/compact", (req, reply) => forwardCompact(req, reply, "responses/compact"));
app.post("/v1/compact", (req, reply) => forwardCompact(req, reply, "compact"));

app.get("/v1/responses/:id", async (req, reply) => {
  const entry = ownedResponse(store, req.bridgeScope, req.params.id, STORE_TTL_MS);
  return entry.response;
});

app.post("/v1/responses", async (req, reply) => {
  const body = req.body || {};
  if (isProbeRequest(body)) return probeOpenAIResponses(body, reply);
  const reqLog = initPayloadLog(req, "openai_responses", body);
  const conversationKey = req.bridgeScope;
  const sessionId = getSessionIdForConversation(conversationKey);
  const history = portableNativeInput(mergeHistory(body.previous_response_id, body.input, conversationKey),
    req.headers['x-exp-legacy-reasoning']);
  const { translatedTools, toolSchemas } = translateAndIndexTools(body.tools);

  const upstreamBody = buildUpstreamRequest({
    input: history, body, translatedTools, toolChoiceFn: simplifyToolChoice,
    extra: {
      clientRequestBody: body,
      instructions: body.instructions,
      text: body.text || responseFormatToTextFormat(body.response_format),
      reasoning: body.reasoning
    }
  });

  if (body.stream) {
    return proxyModelHubStream({ ...upstreamBody, input: history }, reply, sessionId, conversationKey, reqLog, toolSchemas);
  }

  const upstream = await callModelHub(upstreamBody, sessionId, reqLog);
  if (!upstream.ok) {
    reply.code(upstream.status);
    return upstream.json;
  }

  const openaiResp = makeOpenAIResponse(body, upstream.json, toolSchemas);
  saveResponse(openaiResp.id, history, upstream.json, openaiResp, conversationKey, toolSchemas);
  return openaiResp;
});

async function streamChatCompletion(upstreamBody, body, reply, sessionId, reqLog, toolSchemas = new Map()) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  return runModelHubStream({
    body: upstreamBody, reply, sessionId, reqLog, apiLabel: "chat",
    hooks: {
      initState: () => ({
        roleEmitted: false,
        hadToolCall: false,
        outputIndexToToolIndex: new Map(),
        nextToolIndex: 0
      }),
      makeOnEvent: (ctx, st) => {
        function emitRoleOnce() {
          if (st.roleEmitted) return;
          ctx.ensureSseHeaders();
          sse(reply, null, chatCompletionChunk(id, body.model, { role: "assistant" }));
          st.roleEmitted = true;
        }
        st.emitRoleOnce = emitRoleOnce;
        return ({ payload }) => {
          if (!payload) return;
          applyStreamPayloadToAccumulators(payload, ctx.acc);

          if (payload.type === UPSTREAM_EVENT.OUTPUT_ITEM_ADDED && payload.item?.type === "function_call") {
            emitRoleOnce();
            st.hadToolCall = true;
            const item = payload.item;
            const toolIndex = st.nextToolIndex++;
            st.outputIndexToToolIndex.set(payload.output_index, toolIndex);
            sse(reply, null, chatCompletionChunk(id, body.model, {
              tool_calls: [{
                index: toolIndex,
                id: item.call_id || item.id,
                type: "function",
                function: { name: item.name, arguments: "" }
              }]
            }));
            return;
          }

          if (payload.type === UPSTREAM_EVENT.OUTPUT_TEXT_DELTA) {
            if (!payload.delta) return;
            emitRoleOnce();
            sse(reply, null, chatCompletionChunk(id, body.model, { content: payload.delta }));
            return;
          }

          if (payload.type === UPSTREAM_EVENT.FUNCTION_CALL_ARGS_DELTA) {
            if (!payload.delta) return;
            emitRoleOnce();
            const toolIndex = st.outputIndexToToolIndex.get(payload.output_index);
            if (toolIndex != null) {
              sse(reply, null, chatCompletionChunk(id, body.model, {
                tool_calls: [{ index: toolIndex, function: { arguments: payload.delta } }]
              }));
            }
          }
        };
      },
      onUpstreamError: (ctx, st, { resp, errorText, errorJson }) => {
        if (!ctx.isHeadersSent()) {
          reply.code(resp.status);
          return errorJson || { error: { type: "upstream_error", message: errorText || `Upstream error ${resp.status}` } };
        }
        const errMsg = errorJson?.error?.message || errorText || `Upstream error ${resp.status}`;
        sse(reply, null, { error: { message: errMsg, type: errorJson?.error?.type || "api_error" } });
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      },
      onAttemptSuccess: (ctx, st, { resp, headers, stats }) => {
        const { acc, attempt, modelForAttempt } = ctx;
        if (acc.upstreamFailure && !acc.completedResponse) {
          ctx.ensureSseHeaders();
          const upstreamFailure = acc.upstreamFailure;
          const errMsg = upstreamFailure?.error?.message || upstreamFailure?.message || "upstream returned failure";
          sse(reply, null, { error: { message: errMsg, type: upstreamFailure?.error?.type || "upstream_error" } });
          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return reply;
        }

        st.emitRoleOnce();
        const finishReason = st.hadToolCall ? "tool_calls" : "stop";
        sse(reply, null, chatCompletionChunk(id, body.model, {}, finishReason));
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();

        appendStreamCompletionLog({ reqLog, api: "chat", attempt, model: modelForAttempt, resp, headers, stats, acc });
        return reply;
      }
    }
  });
}

app.post("/v1/chat/completions", async (req, reply) => {
  const body = req.body || {};
  if (isProbeRequest(body)) return probeChatCompletion(body, reply);
  const reqLog = initPayloadLog(req, "openai_chat_completions", body);
  const { translatedTools, toolSchemas } = translateAndIndexTools(body.tools);
  const upstreamBody = buildUpstreamRequest({
    input: openAIChatMessagesToInput(body.messages),
    body, translatedTools, toolChoiceFn: simplifyToolChoice,
    extra: {
      text: responseFormatToTextFormat(body.response_format),
      reasoning: body.reasoning
    }
  });

  const conversationKey = req.bridgeScope;
  const sessionId = getSessionIdForConversation(conversationKey);

  if (body.stream) {
    return streamChatCompletion(upstreamBody, body, reply, sessionId, reqLog, toolSchemas);
  }

  const upstream = await callModelHub(upstreamBody, sessionId, reqLog);
  if (!upstream.ok) {
    reply.code(upstream.status);
    return upstream.json;
  }

  const responseText = extractOutputText(upstream.json);
  const toolCalls = convertOutput(upstream.json, toolSchemas)
    .filter(x => x.type === "function_call")
    .map(fc => ({
      id: fc.call_id || fc.id,
      type: "function",
      function: { name: fc.name, arguments: fc.arguments }
    }));

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const finishReason = toolCalls.length ? "tool_calls" : "stop";

  return {
    id,
    object: "chat.completion",
    created: now(),
    model: body.model,
    choices: [{
      index: 0,
      message: toolCalls.length
        ? { role: "assistant", content: null, tool_calls: toolCalls }
        : { role: "assistant", content: responseText, tool_calls: null },
      finish_reason: finishReason
    }],
    usage: toChatCompletionsUsage(upstream.json.usage)
  };
});

app.post("/v1/messages/count_tokens", async (req) => {
  const body = req.body || {};
  const text = JSON.stringify(body.messages ?? "") + (extractSystemMessage(body.system) || "");
  return { input_tokens: Math.ceil(text.length / 4) };
});

app.post("/v1/messages", async (req, reply) => {
  const body = req.body || {};
  if (isProbeRequest(body)) return probeAnthropicMessages(body, reply);
  const reqLog = initPayloadLog(req, "anthropic_messages", body);
  const input = anthropicMessagesToInput(body);
  const translatedTools = anthropicToolsToOpenAITools(body.tools);
  const toolSchemas = makeToolSchemaMap(translatedTools);
  const upstreamBody = {
    model: normalizeModel(body.model),
    input,
    stream: false,
    reasoning: mapAnthropicThinking(body.thinking),
    temperature: body.temperature,
    top_p: body.top_p,
    max_output_tokens: Math.max(64, body.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
    tools: translatedTools,
    tool_choice: mapAnthropicToolChoice(body.tool_choice, translatedTools)
  };

  const conversationKey = req.bridgeScope;
  const sessionId = getSessionIdForConversation(conversationKey);

  if (body.stream) {
    return runModelHubStream({
      body: upstreamBody, reply, sessionId, reqLog, apiLabel: "messages",
      hooks: {
        initState: () => ({
          startedBlocks: new Set(),
          outputIndexToContentIndex: new Map(),
          skippedReasoningIndexes: new Set(),
          bufferedToolCallArgsByIndex: new Map(),
          nextContentIndex: 0,
          messageStarted: false,
          emittedContentBlock: false,
          thinkingRequested: anthropicThinkingRequested(body)
        }),
        makeOnEvent: (ctx, st) => ({ payload }) => {
          if (!payload) return;
          ctx.ensureSseHeaders();
          applyStreamPayloadToAccumulators(payload, ctx.acc);

          if (payload.type === UPSTREAM_EVENT.CREATED) {
            st.messageStarted = true;
            sse(reply, "message_start", {
              type: "message_start",
              message: {
                id: payload.response?.id || rid("msg"),
                type: "message",
                role: "assistant",
                model: body.model || payload.response?.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
              }
            });
            return;
          }

          if (payload.type === UPSTREAM_EVENT.OUTPUT_ITEM_ADDED) {
            const item = payload.item || {};
            const contentIndex = st.nextContentIndex++;
            st.outputIndexToContentIndex.set(payload.output_index, contentIndex);

            if (item.type === "reasoning") {
              if (!st.thinkingRequested) {
                st.skippedReasoningIndexes.add(payload.output_index);
                st.nextContentIndex--;
                return;
              }
              st.startedBlocks.add(contentIndex);
              st.emittedContentBlock = true;
              sse(reply, "content_block_start", {
                type: "content_block_start",
                index: contentIndex,
                content_block: { type: "thinking", thinking: "", signature: item.id || rid("sig") }
              });
              return;
            }

            if (item.type === "message") {
              st.startedBlocks.add(contentIndex);
              st.emittedContentBlock = true;
              sse(reply, "content_block_start", {
                type: "content_block_start",
                index: contentIndex,
                content_block: { type: "text", text: "" }
              });
              return;
            }

            if (item.type === "function_call") {
              st.startedBlocks.add(contentIndex);
              st.emittedContentBlock = true;
              st.bufferedToolCallArgsByIndex.set(payload.output_index, {
                name: item.name,
                arguments: item.arguments || ""
              });
              sse(reply, "content_block_start", {
                type: "content_block_start",
                index: contentIndex,
                content_block: { type: "tool_use", id: item.call_id || item.id, name: item.name, input: {} }
              });
            }
            return;
          }

          if (payload.type === UPSTREAM_EVENT.REASONING_DELTA || payload.type === UPSTREAM_EVENT.REASONING_SUMMARY_TEXT_DELTA) {
            if (st.skippedReasoningIndexes.has(payload.output_index)) return;
            const contentIndex = st.outputIndexToContentIndex.get(payload.output_index);
            if (contentIndex != null) {
              sse(reply, "content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "thinking_delta", thinking: payload.delta || "" }
              });
            }
            return;
          }

          if (payload.type === UPSTREAM_EVENT.OUTPUT_TEXT_DELTA) {
            const contentIndex = st.outputIndexToContentIndex.get(payload.output_index);
            if (contentIndex != null) {
              sse(reply, "content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "text_delta", text: payload.delta || "" }
              });
            }
            return;
          }

          if (payload.type === UPSTREAM_EVENT.FUNCTION_CALL_ARGS_DELTA) {
            if (st.bufferedToolCallArgsByIndex.has(payload.output_index)) {
              const buffered = st.bufferedToolCallArgsByIndex.get(payload.output_index);
              buffered.arguments += payload.delta || "";
            }
            return;
          }

          if (payload.type === UPSTREAM_EVENT.OUTPUT_ITEM_DONE) {
            if (st.skippedReasoningIndexes.has(payload.output_index)) return;
            const contentIndex = st.outputIndexToContentIndex.get(payload.output_index);
            if (contentIndex != null && st.bufferedToolCallArgsByIndex.has(payload.output_index)) {
              const buffered = st.bufferedToolCallArgsByIndex.get(payload.output_index);
              const rawArgs = buffered.arguments || payload.item?.arguments || "{}";
              const sanitizedArgs = sanitizeFunctionCallArguments(buffered.name, rawArgs, toolSchemas);
              if (sanitizedArgs) {
                sse(reply, "content_block_delta", {
                  type: "content_block_delta",
                  index: contentIndex,
                  delta: { type: "input_json_delta", partial_json: sanitizedArgs }
                });
              }
              st.bufferedToolCallArgsByIndex.delete(payload.output_index);
            }
            if (contentIndex != null && st.startedBlocks.has(contentIndex)) {
              sse(reply, "content_block_stop", { type: "content_block_stop", index: contentIndex });
              st.startedBlocks.delete(contentIndex);
            }
            return;
          }

          if (payload.type === UPSTREAM_EVENT.COMPLETED) {
            const finalMessage = makeAnthropicMessage(body, ctx.acc.completedResponse || {}, toolSchemas);
            if (finalMessage.stop_reason === "max_tokens" &&
                finalMessage.content.length === 1 &&
                finalMessage.content[0]?.type === "text" &&
                !st.emittedContentBlock) {
              const fallbackText = finalMessage.content[0].text;
              sse(reply, "content_block_start", {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" }
              });
              sse(reply, "content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: fallbackText }
              });
              sse(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
            }
            sse(reply, "message_delta", {
              type: "message_delta",
              delta: { stop_reason: finalMessage.stop_reason, stop_sequence: null },
              usage: finalMessage.usage
            });
            sse(reply, "message_stop", { type: "message_stop" });
          }
        },
        onUpstreamError: (ctx, st, { resp, errorText }) => {
          ctx.ensureSseHeaders();
          sse(reply, "error", makeStreamErrorPayload(resp.status, errorText, null));
          if (st.messageStarted) sse(reply, "message_stop", { type: "message_stop" });
          reply.raw.end();
          return reply;
        },
        onAttemptSuccess: (ctx, st, { resp, headers, stats }) => {
          if (ctx.acc.upstreamFailure && !ctx.acc.completedResponse) {
            const upstreamFailure = ctx.acc.upstreamFailure;
            const status = upstreamFailure?.response?.status ?? upstreamFailure?.status ?? resp.status;
            const message =
              upstreamFailure?.error?.message ||
              upstreamFailure?.response?.error?.message ||
              upstreamFailure?.message ||
              "upstream returned failure";
            const errorJson = upstreamFailure?.error || upstreamFailure?.response?.error
              ? {
                  error: {
                    type: upstreamFailure?.error?.type || upstreamFailure?.response?.error?.type,
                    message
                  }
                }
              : null;
            sse(reply, "error", makeStreamErrorPayload(status, message, errorJson));
            if (st.messageStarted) sse(reply, "message_stop", { type: "message_stop" });
            appendStreamCompletionLog({ reqLog, api: "messages", attempt: ctx.attempt, model: ctx.modelForAttempt, resp, headers, stats, acc: ctx.acc });
            reply.raw.end();
            return reply;
          }

          appendStreamCompletionLog({ reqLog, api: "messages", attempt: ctx.attempt, model: ctx.modelForAttempt, resp, headers, stats, acc: ctx.acc });
          reply.raw.end();
          return reply;
        }
      }
    });
  }

  const upstream = await callModelHub(upstreamBody, sessionId, reqLog);
  if (!upstream.ok) {
    reply.code(upstream.status);
    return upstream.json;
  }

  const anthropicResp = makeAnthropicMessage(body, upstream.json, toolSchemas);
  return anthropicResp;
});

export { app };
// Reused from the application Bridge supplied for this project. Provider differences
// live in provider.js; authorization, tool conversion and protocol routes are retained.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen({ port: PORT, host: HOST })
    .then(() => app.log.warn(`bridge on http://${HOST}:${PORT} (log level: ${LOG_LEVEL})`))
    .catch(error => { app.log.error(error); process.exit(1); });
}
