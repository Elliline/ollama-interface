# Multi-Provider AI Chat Interface

A modern, web-based chat interface supporting multiple AI providers: Ollama (local), Claude API, and Grok API. Features include streaming responses, voice chat capabilities, and a clean, responsive UI.

## Features

- **Multiple AI Providers**:
  - Ollama (local models)
  - Claude API (Anthropic)
  - Grok API (xAI)

- **Streaming Responses**: Real-time streaming for all providers
- **Voice Chat**: Text-to-speech and speech-to-text support
- **Conversation Mode**: Hands-free voice conversation
- **Settings Modal**: Secure API key management (stored locally in browser)
- **Clean UI**: Modern, dark-themed interface with responsive design

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment (Optional)

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Edit `.env` to add your API keys:

```env
PORT=3000
OLLAMA_HOST=http://localhost:11434

# Optional: Add API keys here (or configure in UI settings)
CLAUDE_API_KEY=sk-ant-...
GROK_API_KEY=xai-...
```

**Note**: API keys can be configured either in the `.env` file (server-side) or through the Settings modal in the UI (client-side, stored in localStorage). Client-side keys take precedence.

### 3. Start the Server

```bash
npm start
```

The interface will be available at `http://localhost:3000`

## Usage

### Provider Selection

1. Click the **Settings** (gear) icon to configure API keys
2. Enter your API keys for Claude and/or Grok (optional)
3. Save settings
4. Select a provider from the **Provider** dropdown
5. Select a model from the **Model** dropdown
6. Start chatting!

### API Key Management

API keys can be managed in two ways:

1. **UI Settings Modal** (Recommended for local use):
   - Click the gear icon in the header
   - Enter API keys for Claude and/or Grok
   - Keys are stored in browser localStorage
   - Toggle visibility with the eye icon

2. **Environment Variables** (Server-side):
   - Add keys to `.env` file
   - Keys are never exposed to the client
   - Useful for shared deployments

### Providers

#### Ollama
- Runs models locally on your machine
- No API key required
- Configure Ollama host in settings if not using default
- Default: `http://localhost:11434`

#### Claude
- Anthropic's Claude API
- Requires API key from https://console.anthropic.com/
- Supports Claude Sonnet 4, Claude 3.5 Haiku, and Claude 3 Opus

#### Grok
- xAI's Grok API (OpenAI-compatible)
- Requires API key from https://console.x.ai/
- Supports Grok 3, Grok 3 Mini, and Grok 2

## Voice Features

- **Speaker Toggle**: Enable/disable text-to-speech responses
- **Microphone**: Hold to record voice input (uses Whisper STT)
- **Conversation Mode**: Hands-free back-and-forth conversation

**Note**: Voice features require separate TTS and STT services configured at the URLs in `script.js`:
- TTS: `http://192.168.1.181:5050/tts`
- STT: `http://192.168.1.181:5051/transcribe`

## Architecture

### Backend (`server.js`)
- Express server acting as a proxy for API requests
- Handles API key management (server-side and client-side)
- Streams responses from all providers
- Endpoints:
  - `/api/providers` - Get available providers
  - `/api/tags` - Get Ollama models
  - `/api/chat` - Ollama chat
  - `/api/claude/chat` - Claude chat
  - `/api/grok/chat` - Grok chat

### Frontend
- `index.html` - Main UI structure
- `script.js` - Application logic, provider handling, streaming
- `style.css` - Modern dark theme styling

## Security

- API keys stored in localStorage are only accessible to the same origin
- Server-side API keys are never exposed to the client
- All API requests go through the backend proxy
- Input sanitization to prevent XSS attacks

## Development

The codebase follows clean, maintainable practices:
- Separate stream processing for each provider
- Error handling with user-friendly messages
- Modular function design
- CSS custom properties for theming

## Troubleshooting

### Ollama not connecting
- Ensure Ollama is running: `ollama serve`
- Check Ollama host configuration in settings
- Default host: `http://localhost:11434`

### Claude/Grok not available
- Verify API key is correctly entered in settings
- Check browser console for error messages
- Ensure you have credits/access to the API

### Voice features not working
- Configure TTS and STT service URLs in `script.js`
- Ensure microphone permissions are granted
- Check that TTS/STT services are running

## License

MIT
