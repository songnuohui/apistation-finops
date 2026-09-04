import { SupplierHttpClient } from './supplier-adapters.mjs';
import { SupplierCredentialVault } from './supplier-credentials.mjs';

const MIN_INTERVAL_SECONDS = 15;
const DEFAULT_INTERVAL_SECONDS = 60;
const MODEL_REQUEST_TIMEOUT_MS = 45_000;
const PING_TIMEOUT_MS = 8_000;
const MAX_WORKERS = 4;
const HISTORY_LIMIT = 60;
const DEGRADED_THRESHOLD_MS = 6_000;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ['operational', 'degraded', 'failed', 'error'].includes(status) ? status : 'error';
}

function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join('');
  if (value && typeof value === 'object') {
    return text(value.text ?? value.content ?? value.output_text ?? '');
  }
  return '';
}

function responseText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.output_text) return text(payload.output_text);
  const choice = payload.choices?.[0];
  if (choice) return text(choice.message?.content ?? choice.text ?? choice.delta?.content);
  if (Array.isArray(payload.content)) {
    return payload.content
      .filter((item) => item?.type === 'text' || item?.text)
      .map((item) => text(item.text ?? item.content))
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(payload.candidates)) {
    return payload.candidates
      .map((item) => text(item?.content?.parts || item?.content))
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(payload.output)) {
    return payload.output
      .filter((item) => !item?.type || item.type === 'message')
      .flatMap((item) => Array.isArray(item.content) ? item.content : [item.content])
      .filter((item) => !item?.type || item.type === 'output_text')
      .map((item) => text(item?.text ?? item?.content))
      .filter(Boolean)
      .join('');
  }
  return '';
}

function challenge() {
  const first = 1 + Math.floor(Math.random() * 50);
  const second = 1 + Math.floor(Math.random() * 50);
  const subtract = Math.random() > 0.5;
  const left = subtract ? Math.max(first, second) : first;
  const right = subtract ? Math.min(first, second) : second;
  const operator = subtract ? '-' : '+';
  return {
    prompt: `Calculate and respond with ONLY the number, nothing else.\n\nQ: 3 + 5 = ?\nA: 8\n\nQ: 12 - 7 = ?\nA: 5\n\nQ: ${left} ${operator} ${right} = ?\nA:`,
    expected: String(subtract ? left - right : left + right),
  };
}

function challengeMatches(value, expected) {
  if (!String(value || '').trim() || !String(expected || '').trim()) return false;
  return String(value).match(/-?\d+/g)?.some((item) => item === String(expected)) || false;
}

function safeHeaders(value) {
  const forbidden = new Set([
    'connection', 'content-length', 'host', 'transfer-encoding',
    'upgrade', 'proxy-authorization', 'proxy-authenticate',
  ]);
  return Object.fromEntries(Object.entries(value || {}).filter(([key, item]) => (
    key && item !== undefined && item !== null
      && !forbidden.has(String(key).toLowerCase())
  )));
}

function sanitizeMessage(error) {
  const message = String(error?.message || error || 'monitor probe failed')
    .replace(/([?&](?:key|api[_-]?key|token|access[_-]?token)=)[^&\s]+/gi, '$1REDACTED')
    .replace(/\b(?:sk-ant-|sk-|xai-)[A-Za-z0-9_-]{6,}\b/g, '***REDACTED***')
    .replace(/\s+/g, ' ')
    .trim();
  return message.slice(0, 500);
}

function requestBody(monitor, model, prompt) {
  const provider = monitor.provider;
  const mode = monitor.bodyOverrideMode || 'off';
  if (mode === 'replace') return monitor.bodyOverride || {};
  const body = provider === 'anthropic'
    ? {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50,
    }
    : provider === 'gemini'
      ? {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 50 },
      }
      : monitor.apiMode === 'responses' && provider === 'openai'
        ? {
          model,
          instructions: 'You are a channel health-check endpoint. Answer the arithmetic challenge exactly and briefly.',
          input: prompt,
          max_output_tokens: 50,
          stream: false,
        }
        : {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 50,
          stream: false,
        };
  if (mode !== 'merge') return body;
  const deny = provider === 'gemini'
    ? new Set(['contents'])
    : monitor.apiMode === 'responses' && provider === 'openai'
      ? new Set(['model', 'instructions', 'input', 'stream'])
      : new Set(['model', 'messages', 'stream']);
  return {
    ...body,
    ...Object.fromEntries(Object.entries(monitor.bodyOverride || {}).filter(([key]) => !deny.has(key))),
  };
}

function requestPath(monitor, model) {
  if (monitor.provider === 'anthropic') return '/v1/messages';
  if (monitor.provider === 'gemini') return `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  if (monitor.provider === 'openai' && monitor.apiMode === 'responses') return '/v1/responses';
  return '/v1/chat/completions';
}

function requestHeaders(monitor) {
  const defaults = monitor.provider === 'anthropic'
    ? { 'x-api-key': monitor.apiKey, 'anthropic-version': '2023-06-01' }
    : monitor.provider === 'gemini'
      ? { 'x-goog-api-key': monitor.apiKey }
      : { Authorization: `Bearer ${monitor.apiKey}` };
  return safeHeaders({ ...defaults, ...monitor.extraHeaders });
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class FinopsGroupMonitorService {
  constructor(repository, config, logger = console) {
    this.repository = repository;
    this.config = config;
    this.logger = logger;
    this.vault = new SupplierCredentialVault(config.supplierCredentialsKey);
    this.client = new SupplierHttpClient(config, {
      allowedHosts: config.monitorAllowedHosts || [],
    });
    this.tasks = new Map();
    this.running = new Map();
    this.waiters = [];
    this.activeWorkers = 0;
    this.started = false;
  }

  status() {
    return {
      running: this.running.size,
      scheduled: this.tasks.size,
      credentialEncryptionAvailable: this.vault.available,
    };
  }

  encryptApiKey(apiKey) {
    return this.vault.encrypt({ apiKey: String(apiKey || '').trim() });
  }

  clearCache() {}

  async acquireWorker() {
    if (this.activeWorkers < MAX_WORKERS) {
      this.activeWorkers += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.activeWorkers += 1;
  }

  releaseWorker() {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    this.waiters.shift()?.();
  }

  nextDelay(intervalSeconds, jitterSeconds) {
    const interval = Math.max(MIN_INTERVAL_SECONDS, Number(intervalSeconds) || DEFAULT_INTERVAL_SECONDS);
    const jitter = Math.max(0, Math.min(Number(jitterSeconds) || 0, interval - MIN_INTERVAL_SECONDS));
    if (!jitter) return interval * 1000;
    return (interval - jitter + Math.floor(Math.random() * (2 * jitter + 1))) * 1000;
  }

  start() {
    if (this.started || this.config.demoMode) return;
    this.started = true;
    this.repository.listEnabledMonitorGroupsForRun()
      .then((groups) => groups.forEach((group) => this.schedule(group)))
      .catch((error) => this.logger.warn('[group-monitor] startup load failed', error?.message || error));
  }

  stop() {
    for (const id of this.tasks.keys()) this.unschedule(id);
    this.started = false;
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  schedule(group) {
    const id = Number(group?.id);
    if (!id || !group.enabled || !group.apiKeyCiphertext || !group.endpoint || !group.primaryModel) {
      if (id) this.unschedule(id);
      return;
    }
    this.unschedule(id);
    const task = { id, timer: null, cancelled: false };
    this.tasks.set(id, task);
    const trigger = () => {
      if (task.cancelled) return;

      // Keep the schedule anchored to each trigger time. A slow upstream
      // request must not add another full interval before the next probe.
      if (!this.running.has(id)) {
        this.runNow(id).catch((error) => {
          if (error?.statusCode === 404 || error?.statusCode === 409) {
            this.unschedule(id);
            return;
          }
          this.logger.warn(`[group-monitor] probe ${id} failed`, error?.message || error);
        });
      }

      task.timer = setTimeout(trigger, this.nextDelay(group.refreshIntervalSeconds, group.jitterSeconds));
      task.timer.unref?.();
    };
    trigger();
  }

  unschedule(id) {
    const task = this.tasks.get(Number(id));
    if (!task) return;
    task.cancelled = true;
    if (task.timer) clearTimeout(task.timer);
    this.tasks.delete(Number(id));
  }

  async reschedule(id) {
    const group = await this.repository.getMonitorGroupForRun(id);
    if (group) this.schedule(group);
    else this.unschedule(id);
  }

  async listAdminGroups() {
    return this.repository.listMonitorGroups();
  }

  async getPublicDashboard() {
    const groups = (await this.repository.listMonitorGroups())
      .filter((group) => group.enabled && group.probeConfigured)
      .map((group) => ({
        id: group.id,
        name: group.name,
        provider: group.provider,
        modelLabel: group.modelLabel || group.primaryModel,
        status: group.status,
        currentMultiplier: group.currentMultiplier,
        availabilityPercent: group.availabilityPercent,
        availabilityByWindow: group.availabilityByWindow,
        availabilitySampleCount: group.availabilitySampleCount,
        availableAccountCount: group.status === 'healthy' || group.status === 'degraded' ? 1 : 0,
        totalAccountCount: 1,
        averageLatencyMs: group.averageLatencyMs,
        averagePingLatencyMs: group.averagePingLatencyMs,
        lastObservedAt: group.lastObservedAt,
        refreshIntervalSeconds: group.refreshIntervalSeconds,
        historyStartedAt: group.historyStartedAt,
        history: group.history,
      }));
    const healthyGroups = groups.filter((group) => group.status === 'healthy').length;
    const degradedGroups = groups.filter((group) => group.status === 'degraded').length;
    const unavailableGroups = groups.filter((group) => group.status === 'unavailable').length;
    const knownGroups = healthyGroups + degradedGroups + unavailableGroups;
    return {
      generatedAt: new Date().toISOString(),
      refreshIntervalSeconds: groups.length
        ? Math.min(...groups.map((group) => Math.max(MIN_INTERVAL_SECONDS, Number(group.refreshIntervalSeconds) || DEFAULT_INTERVAL_SECONDS)))
        : DEFAULT_INTERVAL_SECONDS,
      summary: {
        overallStatus: !groups.length || !knownGroups
          ? 'unknown'
          : unavailableGroups
            ? 'unavailable'
            : degradedGroups || healthyGroups < groups.length ? 'degraded' : 'healthy',
        totalGroups: groups.length,
        healthyGroups,
        degradedGroups,
        unavailableGroups,
      },
      groups,
    };
  }

  async runNow(id) {
    const normalizedId = Number(id);
    if (this.running.has(normalizedId)) return this.running.get(normalizedId);
    const task = this.runMonitor(normalizedId).finally(() => this.running.delete(normalizedId));
    this.running.set(normalizedId, task);
    return task;
  }

  async runMonitor(id) {
    const monitor = await this.repository.getMonitorGroupForRun(id);
    if (!monitor) throw Object.assign(new Error('monitor group not found or source group is inactive'), { statusCode: 404 });
    if (!this.vault.available) throw Object.assign(new Error('monitor API-key encryption is not configured'), { statusCode: 503 });
    let apiKey;
    try {
      apiKey = this.vault.decrypt(monitor.apiKeyCiphertext)?.apiKey || '';
    } catch {
      throw Object.assign(new Error('monitor API key decryption failed; please reconfigure this monitor'), { statusCode: 503 });
    }
    if (!apiKey) throw Object.assign(new Error('monitor API key is not configured'), { statusCode: 400 });
    monitor.apiKey = apiKey;
    await this.acquireWorker();
    try {
      let pingLatencyMs = null;
      try {
        pingLatencyMs = (await this.client.request(monitor.endpoint, '/', {
          method: 'HEAD',
          allowError: true,
          timeoutMs: PING_TIMEOUT_MS,
        })).latencyMs;
      } catch {
        pingLatencyMs = null;
      }
      const models = [...new Set([monitor.primaryModel, ...monitor.extraModels].filter(Boolean))];
      const results = await mapConcurrent(models, 4, (model) => this.checkModel(monitor, model, pingLatencyMs));
      await this.repository.recordMonitorResults(id, results, monitor.historyStartedAt);
      return results;
    } finally {
      monitor.apiKey = '';
      this.releaseWorker();
    }
  }

  async checkModel(monitor, model, pingLatencyMs) {
    const checkedAt = new Date().toISOString();
    const result = {
      model,
      status: 'error',
      latencyMs: null,
      pingLatencyMs,
      message: '',
      checkedAt,
    };
    const probe = challenge();
    const startedAt = Date.now();
    try {
      const response = await this.client.request(monitor.endpoint, requestPath(monitor, model), {
        method: 'POST',
        body: requestBody(monitor, model, probe.prompt),
        headers: requestHeaders(monitor),
        allowError: true,
        timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      });
      result.latencyMs = number(response.latencyMs) ?? (Date.now() - startedAt);
      const statusCode = Number(response.response?.status || 0);
      const payload = response.payload;
      const extracted = responseText(payload);
      if (statusCode < 200 || statusCode >= 300) {
        result.status = 'error';
        const responseBody = String(response.rawBody || '').trim();
        result.message = sanitizeMessage(`upstream HTTP ${statusCode || 0}${responseBody ? `: ${responseBody}` : ''}`);
      } else if (monitor.bodyOverrideMode === 'replace' && !String(extracted).trim()) {
        result.status = 'failed';
        result.message = 'replace-mode: upstream returned 2xx with empty text';
      } else if (monitor.bodyOverrideMode !== 'replace' && !challengeMatches(extracted, probe.expected)) {
        result.status = 'failed';
        result.message = `challenge mismatch (expected ${probe.expected})`;
      } else if (result.latencyMs >= DEGRADED_THRESHOLD_MS) {
        result.status = 'degraded';
        result.message = `slow response: ${result.latencyMs}ms`;
      } else {
        result.status = 'operational';
      }
    } catch (error) {
      result.status = 'error';
      result.message = sanitizeMessage(error);
      result.latencyMs = Date.now() - startedAt;
    }
    result.checkedAt = new Date().toISOString();
    result.status = normalizeStatus(result.status);
    return result;
  }
}
