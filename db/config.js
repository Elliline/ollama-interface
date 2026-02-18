/**
 * Centralized configuration loader for Squatch Neuro Hub
 * Reads from data/config.json, deep-merges with defaults,
 * and applies environment variable overrides at runtime.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../data/config.json');

const DEFAULTS = {
  providers: {
    ollama: { host: 'http://localhost:11434' },
    llamacpp: { host: 'http://localhost:8080' }
  },
  models: {
    chat: { provider: 'llamacpp', model: 'scout' },
    extraction: { provider: 'ollama', model: 'gemma3:4b' },
    heartbeat: { provider: 'ollama', model: 'qwen3:14b' },
    embedding: { provider: 'ollama', model: 'nomic-embed-text' }
  },
  heartbeat: { enabled: true, intervalHours: 2, warmupMinutes: 5 },
  memory: {
    similarityThreshold: 0.55,
    clusterLinkThreshold: 0.50,
    dailyLogRetentionDays: 7,
    hybridSearchWeights: { vector: 0.6, bm25: 0.4 }
  }
};

let currentConfig = null;

/**
 * Recursively deep-merge source into target.
 * Objects merge, primitives and arrays replace.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Load config from disk, deep-merge with defaults.
 * Auto-creates config file if missing.
 */
function loadConfig() {
  let fileConfig = {};

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      fileConfig = JSON.parse(raw);
    } else {
      // Auto-create with defaults
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf8');
      console.log('[Config] Created default config at', CONFIG_PATH);
    }
  } catch (err) {
    console.error('[Config] Error reading config file:', err.message);
  }

  currentConfig = deepMerge(DEFAULTS, fileConfig);
  return currentConfig;
}

/**
 * Get the current config with env var overrides applied.
 * Env vars OLLAMA_HOST and LLAMACPP_HOST win over file values.
 */
function getConfig() {
  if (!currentConfig) {
    loadConfig();
  }

  // Deep clone to avoid env overrides mutating the cached config
  const config = JSON.parse(JSON.stringify(currentConfig));

  if (process.env.OLLAMA_HOST) {
    config.providers.ollama.host = process.env.OLLAMA_HOST;
  }
  if (process.env.LLAMACPP_HOST) {
    config.providers.llamacpp.host = process.env.LLAMACPP_HOST;
  }

  return config;
}

/**
 * Deep-merge a partial update into the current config and persist to disk.
 * @param {Object} partial - Partial config to merge
 * @returns {Object} Updated config
 */
function updateConfig(partial) {
  if (!currentConfig) {
    loadConfig();
  }

  currentConfig = deepMerge(currentConfig, partial);

  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), 'utf8');
    console.log('[Config] Saved config to', CONFIG_PATH);
  } catch (err) {
    console.error('[Config] Error writing config file:', err.message);
  }

  return getConfig();
}

module.exports = { getConfig, updateConfig, loadConfig };
