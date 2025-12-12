/**
 * Express backend proxy server for Ollama Chat Interface
 * Handles API key management securely via environment variables
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();

// Configuration from environment
const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const GROK_API_KEY = process.env.GROK_API_KEY || '';
const TTS_HOST = process.env.TTS_HOST || 'http://localhost:5050';
const STT_HOST = process.env.STT_HOST || 'http://localhost:5051';

// Additional allowed Ollama hosts (comma-separated in .env)
const ALLOWED_OLLAMA_HOSTS = process.env.ALLOWED_OLLAMA_HOSTS
  ? process.env.ALLOWED_OLLAMA_HOSTS.split(',').map(h => h.trim())
  : [];

// ============ Security Configuration ============

// SECURITY: Rate limiting to prevent API abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // Limit each IP to 20 chat requests per minute
  message: { error: 'Too many chat requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// SECURITY: Content Security Policy headers
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob: data:; " +
    "connect-src 'self' https://cloudflareinsights.com; " +
    "font-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none';"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Middleware
app.use(express.json({ limit: '10mb' })); // Limit payload size

// SECURITY FIX: Serve only the public directory, not the entire project
app.use(express.static(path.join(__dirname, 'public')));

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);

// ============ Security Validation Functions ============

// SECURITY: Validate Ollama host against allowlist to prevent SSRF
function isValidOllamaHost(host) {
  if (!host) return false;

  try {
    const url = new URL(host);
    const hostname = url.hostname;

    // Allow localhost and loopback
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }

    // Allow private network ranges (RFC 1918)
    if (hostname.match(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
      return true;
    }
    if (hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/)) {
      return true;
    }
    if (hostname.match(/^192\.168\.\d{1,3}\.\d{1,3}$/)) {
      return true;
    }

    // Allow explicitly configured hosts
    if (ALLOWED_OLLAMA_HOSTS.includes(host)) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

// SECURITY: Validate model name format
function isValidModelName(model) {
  if (!model || typeof model !== 'string') return false;

  // Allow alphanumeric, hyphens, underscores, dots, colons (for model versions)
  // Limit length to prevent abuse
  return /^[a-zA-Z0-9._:-]{1,100}$/.test(model);
}

// SECURITY: Validate message array
function isValidMessageArray(messages) {
  if (!Array.isArray(messages)) return false;

  // Limit number of messages to prevent memory abuse
  if (messages.length > 100) return false;

  // Validate each message structure
  return messages.every(msg => {
    if (!msg || typeof msg !== 'object') return false;
    if (typeof msg.role !== 'string' || typeof msg.content !== 'string') return false;
    if (!['user', 'assistant', 'system'].includes(msg.role)) return false;
    // Limit individual message size
    if (msg.content.length > 100000) return false;
    return true;
  });
}

// Provider configuration
const PROVIDERS = {
  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    available: true, // Always available if Ollama is running
    models: [] // Dynamically loaded
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    available: !!CLAUDE_API_KEY,
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' }
    ]
  },
  grok: {
    id: 'grok',
    name: 'Grok',
    available: !!GROK_API_KEY,
    models: [
      { id: 'grok-3', name: 'Grok 3' },
      { id: 'grok-3-mini', name: 'Grok 3 Mini' },
      { id: 'grok-2', name: 'Grok 2' }
    ]
  }
};

// ============ Provider Endpoints ============

// Get available providers (POST to receive client API key status)
app.post('/api/providers', (req, res) => {
  const { hasClaudeKey, hasGrokKey } = req.body;

  const availableProviders = [];

  // Ollama is always available (if running)
  availableProviders.push({
    id: PROVIDERS.ollama.id,
    name: PROVIDERS.ollama.name,
    models: []
  });

  // Claude is available if server has key OR client has key
  if (CLAUDE_API_KEY || hasClaudeKey) {
    availableProviders.push({
      id: PROVIDERS.claude.id,
      name: PROVIDERS.claude.name,
      models: PROVIDERS.claude.models
    });
  }

  // Grok is available if server has key OR client has key
  if (GROK_API_KEY || hasGrokKey) {
    availableProviders.push({
      id: PROVIDERS.grok.id,
      name: PROVIDERS.grok.name,
      models: PROVIDERS.grok.models
    });
  }

  res.json({ providers: availableProviders });
});

// Legacy GET endpoint for backwards compatibility
app.get('/api/providers', (req, res) => {
  const availableProviders = Object.values(PROVIDERS)
    .filter(p => p.available)
    .map(p => ({
      id: p.id,
      name: p.name,
      models: p.id === 'ollama' ? [] : p.models
    }));
  res.json({ providers: availableProviders });
});

// ============ Ollama Proxy ============

// Helper to get validated Ollama host
function getOllamaHost(requestBody) {
  const requestedHost = requestBody?.ollamaHost;

  // If no custom host requested, use default
  if (!requestedHost) {
    return OLLAMA_HOST;
  }

  // SECURITY: Validate requested host to prevent SSRF
  if (!isValidOllamaHost(requestedHost)) {
    throw new Error('Invalid Ollama host. Only localhost, private network IPs, and explicitly allowed hosts are permitted.');
  }

  return requestedHost;
}

// Proxy Ollama tags (model list) - POST to accept custom host
app.post('/api/tags', async (req, res) => {
  try {
    const host = getOllamaHost(req.body);
    const response = await fetch(`${host}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Ollama tags error:', error.message);
    res.status(503).json({ error: error.message || 'Ollama is not available', models: [] });
  }
});

// Legacy GET endpoint for backwards compatibility
app.get('/api/tags', async (req, res) => {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Ollama tags error:', error.message);
    res.status(503).json({ error: 'Ollama is not available', models: [] });
  }
});

// Proxy Ollama chat
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { model, messages, ollamaHost, ...otherParams } = req.body;

    // SECURITY: Validate inputs
    if (!isValidModelName(model)) {
      return res.status(400).json({ error: 'Invalid model name' });
    }

    if (!isValidMessageArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages array' });
    }

    const host = getOllamaHost(req.body);

    // Build validated request body
    const ollamaBody = {
      model,
      messages,
      ...otherParams
    };

    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaBody)
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    // Stream the response
    res.setHeader('Content-Type', 'application/x-ndjson');
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    console.error('Ollama chat error:', error.message);
    if (!res.headersSent) {
      res.status(503).json({ error: error.message || 'Ollama is not available' });
    }
  }
});

// ============ Claude API Proxy ============

app.post('/api/claude/chat', chatLimiter, async (req, res) => {
  const { model, messages, apiKey } = req.body;

  // SECURITY: Validate inputs
  if (!isValidModelName(model)) {
    return res.status(400).json({ error: 'Invalid model name' });
  }

  if (!isValidMessageArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages array' });
  }

  // Use client key if provided, otherwise fall back to server key
  const claudeKey = apiKey || CLAUDE_API_KEY;

  if (!claudeKey) {
    return res.status(401).json({ error: 'Claude API key not configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 4096,
        stream: true,
        messages: messages
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Claude API error:', error);
      return res.status(response.status).json({ error: 'Claude API error' });
    }

    // Stream SSE response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    console.error('Claude proxy error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to connect to Claude API' });
    }
  }
});

// ============ Grok API Proxy ============

app.post('/api/grok/chat', chatLimiter, async (req, res) => {
  const { model, messages, apiKey } = req.body;

  // SECURITY: Validate inputs
  if (!isValidModelName(model)) {
    return res.status(400).json({ error: 'Invalid model name' });
  }

  if (!isValidMessageArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages array' });
  }

  // Use client key if provided, otherwise fall back to server key
  const grokKey = apiKey || GROK_API_KEY;

  if (!grokKey) {
    return res.status(401).json({ error: 'Grok API key not configured' });
  }

  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${grokKey}`
      },
      body: JSON.stringify({
        model: model,
        stream: true,
        messages: messages
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Grok API error:', error);
      return res.status(response.status).json({ error: 'Grok API error' });
    }

    // Stream SSE response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    console.error('Grok proxy error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to connect to Grok API' });
    }
  }
});

// ============ Voice Assistant Proxy ============

// Text-to-Speech proxy (Kokoro TTS)
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice, speed } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Limit text length to prevent abuse
    if (text.length > 10000) {
      return res.status(400).json({ error: 'Text too long (max 10000 characters)' });
    }

    const response = await fetch(`${TTS_HOST}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: voice || 'af_heart',
        speed: speed || 1.0
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('TTS error:', error);
      return res.status(response.status).json({ error: 'TTS service error' });
    }

    // Stream audio response
    res.setHeader('Content-Type', response.headers.get('Content-Type') || 'audio/wav');
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    console.error('TTS proxy error:', error.message);
    if (!res.headersSent) {
      res.status(503).json({ error: 'TTS service unavailable' });
    }
  }
});

// Speech-to-Text proxy (Whisper STT)
app.post('/api/stt', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '10mb' }), async (req, res) => {
  try {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No audio data provided' });
    }

    // Create multipart form data for Whisper STT
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const contentType = req.headers['content-type'] || 'audio/webm';
    const extension = contentType.includes('wav') ? 'wav' : 'webm';

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="recording.${extension}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, req.body, footer]);

    const response = await fetch(`${STT_HOST}/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: body
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('STT error:', error);
      return res.status(response.status).json({ error: 'STT service error' });
    }

    const result = await response.json();
    res.json(result);
  } catch (error) {
    console.error('STT proxy error:', error.message);
    if (!res.headersSent) {
      res.status(503).json({ error: 'STT service unavailable' });
    }
  }
});

// STT with multipart form data (for file uploads)
app.post('/api/stt/upload', express.raw({ type: 'audio/*', limit: '10mb' }), async (req, res) => {
  try {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No audio data provided' });
    }

    const response = await fetch(`${STT_HOST}/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] || 'audio/webm'
      },
      body: req.body
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('STT error:', error);
      return res.status(response.status).json({ error: 'STT service error' });
    }

    const result = await response.json();
    res.json(result);
  } catch (error) {
    console.error('STT proxy error:', error.message);
    if (!res.headersSent) {
      res.status(503).json({ error: 'STT service unavailable' });
    }
  }
});

// ============ Start Server ============

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Security features enabled:');
  console.log('  - Rate limiting: Active');
  console.log('  - Content Security Policy: Active');
  console.log('  - SSRF protection: Active (Ollama host validation)');
  console.log('  - Input validation: Active');
  console.log('Available providers:');
  console.log(`  - Ollama: ${OLLAMA_HOST}`);
  console.log(`  - Claude: ${CLAUDE_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`  - Grok: ${GROK_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log('Voice services:');
  console.log(`  - TTS (Kokoro): ${TTS_HOST}`);
  console.log(`  - STT (Whisper): ${STT_HOST}`);
  if (ALLOWED_OLLAMA_HOSTS.length > 0) {
    console.log(`  - Additional Ollama hosts: ${ALLOWED_OLLAMA_HOSTS.join(', ')}`);
  }
});
