/**
 * Ollama Chat Interface
 * A web-based interface for interacting with local AI models
 */

// DOM Elements
const providerSelect = document.getElementById('providerSelect');
const modelSelect = document.getElementById('modelSelect');
const newChatBtn = document.getElementById('newChatBtn');
const chatContainer = document.getElementById('chatContainer');
const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const typingIndicator = document.getElementById('typingIndicator');
const micBtn = document.getElementById('micBtn');
const convoModeBtn = document.getElementById('convoModeBtn');
const searchToggleBtn = document.getElementById('searchToggleBtn');
const speakerToggle = document.getElementById('speakerToggle');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeModal = document.getElementById('closeModal');
const saveSettings = document.getElementById('saveSettings');

// SquatchServe model status elements
const modelStatusBar = document.getElementById('modelStatusBar');
const modelStatusText = document.getElementById('modelStatusText');
const unloadModelBtn = document.getElementById('unloadModelBtn');

// State variables
let currentProvider = '';
let currentModel = '';
let providers = [];
let conversation = [];
let isTyping = false;
let squatchserveStatusInterval = null;
let loadedSquatchserveModel = null;
let lastAssistantMessageId = null;
let streamingMessageElement = null;
let pendingContent = null;
let animationFrameId = null;
let ttsEnabled = false;
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let conversationMode = false;
let toolsEnabled = false;
let silenceTimer = null;
let audioContext = null;
let analyser = null;
let audioUnlocked = false;
const TTS_URL = '/api/tts';
const STT_URL = '/api/stt';

// Conversation history state
let currentConversationId = null;
let conversations = [];
let sidebarCollapsed = false;   

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
  loadProviders();
  loadConversations();
  setupEventListeners();
  setupSidebarListeners();
  loadSettings();
  checkMobileView();
});

// Load available providers
async function loadProviders() {
  try {
    const hasClaudeKey = !!localStorage.getItem('claudeApiKey');
    const hasGrokKey = !!localStorage.getItem('grokApiKey');
    const hasOpenAIKey = !!localStorage.getItem('openaiApiKey');

    const response = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hasClaudeKey, hasGrokKey, hasOpenAIKey })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    providers = data.providers || [];

    providerSelect.innerHTML = '<option value="">Select a provider</option>';
    providers.forEach(provider => {
      const option = document.createElement('option');
      option.value = provider.id;
      // Add visual indicator if API key is missing for providers that require it
      const needsKey = provider.requiresKey && !provider.hasKey;
      option.textContent = needsKey ? `${provider.name} (API key required)` : provider.name;
      option.dataset.requiresKey = provider.requiresKey;
      option.dataset.hasKey = provider.hasKey;
      providerSelect.appendChild(option);
    });

    // Restore saved provider
    const savedProvider = localStorage.getItem('selectedProvider');
    if (savedProvider) {
      providerSelect.value = savedProvider;
      currentProvider = savedProvider;
      await loadModelsForProvider(savedProvider);

      // Initialize model status bar for SquatchServe
      updateModelStatusBarVisibility();
    }
  } catch (error) {
    console.error('Error loading providers:', error);
    addMessage('error', 'Failed to load providers. Please check your connection.');
  }
}

// Load models for selected provider
async function loadModelsForProvider(providerId) {
  try {
    modelSelect.innerHTML = '<option value="">Select a model</option>';

    const provider = providers.find(p => p.id === providerId);
    if (!provider) return;

    // Check if API key is required but missing
    if (provider.requiresKey && !provider.hasKey) {
      const keyName = providerId === 'claude' ? 'Claude' : providerId === 'openai' ? 'OpenAI' : 'Grok';
      addMessage('system', `${keyName} requires an API key. Click the ⚙️ Settings button to add your API key.`);
      return;
    }

    if (providerId === 'ollama') {
      // Fetch Ollama models dynamically
      const ollamaHost = localStorage.getItem('ollamaHost') || undefined;
      const response = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollamaHost })
      });

      if (!response.ok) {
        throw new Error('Ollama not available');
      }

      const data = await response.json();
      const models = data.models || [];

      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.name;
        option.textContent = model.name;
        modelSelect.appendChild(option);
      });
    } else if (providerId === 'openai') {
      // Fetch OpenAI models dynamically
      const apiKey = localStorage.getItem('openaiApiKey');
      const response = await fetch('/api/openai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey })
      });

      if (!response.ok) {
        throw new Error('Failed to fetch OpenAI models');
      }

      const data = await response.json();
      const models = data.models || [];

      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
      });
    } else if (providerId === 'squatchserve') {
      // Fetch SquatchServe models dynamically
      const squatchserveHost = localStorage.getItem('squatchserveHost') || '';
      const url = squatchserveHost
        ? `/api/squatchserve/models?host=${encodeURIComponent(squatchserveHost)}`
        : '/api/squatchserve/models';
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error('SquatchServe not available');
      }

      const data = await response.json();
      const models = data.models || [];

      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
      });
    } else if (providerId === 'llamacpp') {
      // Fetch Llama.cpp models dynamically
      const response = await fetch('/api/llamacpp/models');

      if (!response.ok) {
        throw new Error('Llama.cpp not available');
      }

      const data = await response.json();
      const models = data.models || [];

      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
      });
    } else {
      // Use pre-defined models for Claude and Grok
      provider.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
      });
    }

    // Restore saved model
    const savedModel = localStorage.getItem('selectedModel');
    if (savedModel) {
      modelSelect.value = savedModel;
      currentModel = savedModel;
    }
  } catch (error) {
    console.error('Error loading models:', error);
    const errorHint = providerId === 'ollama' ? 'Make sure Ollama is running.' :
                      providerId === 'squatchserve' ? 'Make sure SquatchServe is running (default: localhost:8111).' :
                      providerId === 'llamacpp' ? 'Make sure llama.cpp server is running (default: localhost:8080).' :
                      'Check your API key in settings.';
    addMessage('error', `Failed to load models for ${providerId}. ${errorHint}`);
  }
}

// Load conversation from session storage
function loadConversation() {
  try {
    const savedConversation = sessionStorage.getItem('ollamaChatConversation');
    if (savedConversation) {
      conversation = JSON.parse(savedConversation);
      renderMessages();
    } else {
      // Show welcome message
      addMessage('system', 'Welcome to Ollama Chat! Select a model and start chatting.');
    }
  } catch (error) {
    console.error('Error loading conversation:', error);
    conversation = [];
    addMessage('system', 'Welcome to Ollama Chat! Select a model and start chatting.');
  }
}

// Save conversation to session storage
function saveConversation() {
  try {
    sessionStorage.setItem('ollamaChatConversation', JSON.stringify(conversation));
  } catch (error) {
    console.error('Error saving conversation:', error);
  }
}

// Set up event listeners
function setupEventListeners() {
  providerSelect.addEventListener('change', handleProviderChange);
  modelSelect.addEventListener('change', handleModelChange);
  newChatBtn.addEventListener('click', newChat);
  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', handleKeyDown);
  messageInput.addEventListener('input', autoResizeInput);
  micBtn.addEventListener('mousedown', startRecording);
  convoModeBtn.addEventListener('click', toggleConversationMode);
  searchToggleBtn.addEventListener('click', toggleTools);
  micBtn.addEventListener('mouseup', stopRecording);
  micBtn.addEventListener('mouseleave', stopRecording);
  speakerToggle.addEventListener('click', toggleTTS);
  settingsBtn.addEventListener('click', openSettings);
  closeModal.addEventListener('click', closeSettings);
  saveSettings.addEventListener('click', saveSettingsHandler);

  // Toggle password visibility
  document.querySelectorAll('.toggle-visibility-btn').forEach(btn => {
    btn.addEventListener('click', togglePasswordVisibility);
  });

  // SquatchServe unload button
  if (unloadModelBtn) {
    unloadModelBtn.addEventListener('click', unloadSquatchserveModel);
  }

  // Close modal on outside click
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      closeSettings();
    }
  });
}

// Handle provider selection
async function handleProviderChange() {
  currentProvider = providerSelect.value;
  localStorage.setItem('selectedProvider', currentProvider);

  // Update model status bar visibility for SquatchServe
  updateModelStatusBarVisibility();

  if (currentProvider) {
    await loadModelsForProvider(currentProvider);
    addMessage('system', `Provider selected: ${providerSelect.options[providerSelect.selectedIndex].text}`);
  }
}

// Handle model selection
function handleModelChange() {
  currentModel = modelSelect.value;
  localStorage.setItem('selectedModel', currentModel);
  
  if (currentModel) {
    addMessage('system', `Model selected: ${currentModel}`);
  }
}

// Handle sending a message
async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || !currentModel || !currentProvider) {
    if (!currentProvider || !currentModel) {
      addMessage('error', 'Please select a provider and model first.');
    }
    return;
  }

  // Add user message to conversation
  addMessage('user', message);
  messageInput.value = '';
  autoResizeInput();

  // Show typing indicator
  showTypingIndicator();

  try {
    let response = null;
    const conversationMessages = conversation
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .map(msg => ({
        role: msg.role,
        content: msg.content
      }));

    // Use memory-enhanced chat endpoint
    const ollamaHost = localStorage.getItem('ollamaHost') || undefined;
    const squatchserveHost = localStorage.getItem('squatchserveHost') || undefined;
    const llamacppHost = localStorage.getItem('llamacppHost') || undefined;
    const apiKey = currentProvider === 'claude'
      ? localStorage.getItem('claudeApiKey')
      : currentProvider === 'openai'
        ? localStorage.getItem('openaiApiKey')
        : currentProvider === 'grok'
          ? localStorage.getItem('grokApiKey')
          : undefined;

    const requestBody = {
      model: currentModel,
      messages: conversationMessages,
      provider: currentProvider,
      conversation_id: currentConversationId,
      ollamaHost,
      squatchserveHost,
      llamacppHost,
      apiKey,
      toolsEnabled,
      searxngHost: localStorage.getItem('searxngHost') || undefined
    };
    console.log('[sendMessage] Provider:', currentProvider, '| toolsEnabled:', toolsEnabled, '(type:', typeof toolsEnabled, ')');

    response = await fetch('/api/chat/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    // SECURITY FIX: Check if response exists before accessing properties
    if (!response) {
      throw new Error('No response received from provider');
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }

    // Get conversation ID from response headers
    const newConversationId = response.headers.get('X-Conversation-Id');
    const hasMemoryContext = response.headers.get('X-Has-Memory-Context') === 'true';

    if (newConversationId && !currentConversationId) {
      currentConversationId = newConversationId;
    }

    // Show memory context indicator if applicable
    if (hasMemoryContext) {
      showMemoryIndicator();
    }

    // Show tools indicator if applicable
    const usedTools = response.headers.get('X-Tools-Used') === 'true';
    if (usedTools) {
      showToolsIndicator();
    }

    // Handle streaming response
    let fullResponse = '';
    const assistantMessageId = Date.now();
    conversation.push({
      role: 'assistant',
      content: '',
      id: assistantMessageId
    });
    lastAssistantMessageId = assistantMessageId;

    // Create the DOM element for streaming
    streamingMessageElement = document.createElement('div');
    streamingMessageElement.classList.add('message', 'assistant');
    streamingMessageElement.innerHTML = '<div class="message-content"></div>';
    messagesContainer.appendChild(streamingMessageElement);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    // Process stream based on provider
    if (currentProvider === 'ollama' || currentProvider === 'squatchserve') {
      // Ollama and SquatchServe use NDJSON streaming format
      fullResponse = await processOllamaStream(response);
    } else if (currentProvider === 'claude') {
      fullResponse = await processClaudeStream(response);
    } else if (currentProvider === 'grok' || currentProvider === 'openai' || currentProvider === 'llamacpp') {
      // Grok, OpenAI, and Llama.cpp use OpenAI-compatible SSE streaming format
      fullResponse = await processGrokStream(response);
    }

    // Update the assistant message with the complete response
    console.log('[sendMessage] Stream complete, fullResponse length:', fullResponse.length);
    const assistantMessageIndex = conversation.findIndex(msg => msg.id === assistantMessageId);
    if (assistantMessageIndex !== -1) {
      conversation[assistantMessageIndex].content = fullResponse;
      console.log('[sendMessage] Updated conversation at index:', assistantMessageIndex);
    }

    // Cancel any pending animation frame to avoid stale updates
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }

    // Clear streaming state BEFORE re-rendering
    streamingMessageElement = null;
    pendingContent = null;
    animationFrameId = null;

    saveConversation();

    // Force re-render to ensure UI matches conversation state
    // This guarantees the response is displayed even if streaming updates failed
    renderMessages();

    speakText(fullResponse);

    // Refresh conversation list to show the new/updated conversation
    loadConversations();

  } catch (error) {
    console.error('Error sending message:', error);
    addMessage('error', `Failed to send message: ${error.message}`);
  } finally {
    hideTypingIndicator();
  }
}

// Show memory context indicator
function showMemoryIndicator() {
  const indicator = document.createElement('div');
  indicator.className = 'memory-context-indicator';
  indicator.textContent = 'Using context from previous conversations';
  messagesContainer.appendChild(indicator);

  // Remove after a few seconds
  setTimeout(() => {
    indicator.remove();
  }, 5000);
}

// Show tools usage indicator
function showToolsIndicator() {
  const indicator = document.createElement('div');
  indicator.className = 'search-results-indicator';
  indicator.textContent = 'Enhanced with tool results';
  messagesContainer.appendChild(indicator);

  setTimeout(() => {
    indicator.remove();
  }, 5000);
}

// Process Ollama streaming response
async function processOllamaStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = ''; // Buffer for partial lines across chunks

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // SECURITY FIX: Use stream:true to handle partial UTF-8 sequences
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // Keep the last incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim() === '') continue;

        try {
          const data = JSON.parse(line);
          if (data.message && data.message.content) {
            fullResponse += data.message.content;
            updateLastMessage(fullResponse);
          }
        } catch (e) {
          console.error('Error parsing Ollama JSON:', e);
        }
      }
    }

    // Process any remaining buffered content
    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer);
        if (data.message && data.message.content) {
          fullResponse += data.message.content;
          updateLastMessage(fullResponse);
        }
      } catch (e) {
        console.error('Error parsing final Ollama JSON:', e);
      }
    }
  } finally {
    // SECURITY FIX: Always release the reader lock
    reader.releaseLock();
  }

  return fullResponse;
}

// Process Claude streaming response
async function processClaudeStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = ''; // Buffer for partial lines across chunks

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // SECURITY FIX: Use stream:true to handle partial UTF-8 sequences
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // Keep the last incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              fullResponse += parsed.delta.text;
              updateLastMessage(fullResponse);
            }
          } catch (e) {
            console.error('Error parsing Claude SSE:', e);
          }
        }
      }
    }

    // Process any remaining buffered content (handles missing trailing newline)
    if (buffer.trim()) {
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6);
        if (data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              fullResponse += parsed.delta.text;
              updateLastMessage(fullResponse);
            }
          } catch (e) {
            console.error('Error parsing final Claude SSE:', e);
          }
        }
      }
    }
  } finally {
    // SECURITY FIX: Always release the reader lock
    reader.releaseLock();
  }

  return fullResponse;
}

// Process Grok streaming response (OpenAI-compatible)
async function processGrokStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = ''; // Buffer for partial lines across chunks
  let chunkCount = 0;

  console.log('[processGrokStream] Starting stream processing');

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('[processGrokStream] Stream done, chunks received:', chunkCount);
        break;
      }

      chunkCount++;
      // SECURITY FIX: Use stream:true to handle partial UTF-8 sequences
      buffer += decoder.decode(value, { stream: true });

      // Log first chunk to see the format
      if (chunkCount === 1) {
        console.log('[processGrokStream] First chunk:', buffer.substring(0, 200));
      }

      const lines = buffer.split('\n');

      // Keep the last incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine === 'data: [DONE]') continue;

        let jsonStr = trimmedLine;

        // Handle SSE format (data: {...})
        if (trimmedLine.startsWith('data: ')) {
          jsonStr = trimmedLine.slice(6);
          if (jsonStr === '[DONE]') continue;
        }

        try {
          const parsed = JSON.parse(jsonStr);
          let content = null;

          // OpenAI-compatible streaming format (delta)
          if (parsed.choices?.[0]?.delta?.content) {
            content = parsed.choices[0].delta.content;
          }
          // Non-streaming format (message instead of delta)
          else if (parsed.choices?.[0]?.message?.content) {
            content = parsed.choices[0].message.content;
          }
          // Ollama format
          else if (parsed.message?.content) {
            content = parsed.message.content;
          }
          // Direct content field
          else if (parsed.content) {
            content = parsed.content;
          }
          // Direct text field
          else if (parsed.text) {
            content = parsed.text;
          }
          // Response field (some providers use this)
          else if (parsed.response) {
            content = parsed.response;
          }

          if (content) {
            fullResponse += content;
            updateLastMessage(fullResponse);
          }
        } catch (e) {
          // Not valid JSON, skip this line
        }
      }
    }

    // Process any remaining buffered content (handles missing trailing newline)
    if (buffer.trim()) {
      let jsonStr = buffer.trim();

      // Handle SSE format
      if (jsonStr.startsWith('data: ')) {
        jsonStr = jsonStr.slice(6);
      }

      if (jsonStr && jsonStr !== '[DONE]') {
        try {
          const parsed = JSON.parse(jsonStr);
          let content = null;

          if (parsed.choices?.[0]?.delta?.content) {
            content = parsed.choices[0].delta.content;
          } else if (parsed.choices?.[0]?.message?.content) {
            content = parsed.choices[0].message.content;
          } else if (parsed.message?.content) {
            content = parsed.message.content;
          } else if (parsed.content) {
            content = parsed.content;
          } else if (parsed.text) {
            content = parsed.text;
          } else if (parsed.response) {
            content = parsed.response;
          }

          if (content) {
            fullResponse += content;
            updateLastMessage(fullResponse);
          }
        } catch (e) {
          // Not valid JSON, ignore
        }
      }
    }
  } finally {
    // SECURITY FIX: Always release the reader lock
    reader.releaseLock();
  }

  console.log('[processGrokStream] Final response length:', fullResponse.length);
  if (fullResponse.length === 0) {
    console.log('[processGrokStream] WARNING: No content extracted! Remaining buffer:', buffer);
  }

  return fullResponse;
}

// Handle key down events (Enter to send, Shift+Enter for new line)
function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// Auto-resize textarea
function autoResizeInput() {
  messageInput.style.height = 'auto';
  messageInput.style.height = (messageInput.scrollHeight) + 'px';
}

// Add message to conversation
function addMessage(role, content) {
  conversation.push({
    role,
    content,
    id: Date.now()
  });
  
  saveConversation();
  renderMessages();
}

// Update the last message (for streaming responses)
function updateLastMessage(content) {
  if (streamingMessageElement) {
    pendingContent = content;
    
    // Only update once per animation frame (usually 60fps)
    if (!animationFrameId) {
      animationFrameId = requestAnimationFrame(() => {
        if (pendingContent && streamingMessageElement) {
          const contentElement = streamingMessageElement.querySelector('.message-content');
          contentElement.innerHTML = formatMessageContent(pendingContent);
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        animationFrameId = null;
      });
    }
  }
}

// Render messages to the chat container
function renderMessages() {
  messagesContainer.innerHTML = '';
  
  conversation.forEach((msg, index) => {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', msg.role);
    
    if (msg.role === 'user') {
      messageElement.innerHTML = `<div class="message-content">${escapeHtml(msg.content)}</div>`;
    } else if (msg.role === 'assistant') {
      messageElement.innerHTML = `<div class="message-content">${formatMessageContent(msg.content)}</div>`;
    } else if (msg.role === 'system') {
      messageElement.innerHTML = `<div class="message-content system-message">${escapeHtml(msg.content)}</div>`;
    } else if (msg.role === 'error') {
      messageElement.innerHTML = `<div class="message-content error-message">${escapeHtml(msg.content)}</div>`;
    }
    
    messagesContainer.appendChild(messageElement);
  });
  
  // Scroll to bottom
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Format message content (handle markdown-like formatting)
function formatMessageContent(content) {
  // SECURITY: Escape HTML first to prevent XSS, then apply markdown formatting
  const escaped = escapeHtml(content);
  return escaped
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Show typing indicator
function showTypingIndicator() {
  isTyping = true;
  typingIndicator.style.display = 'flex';
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Hide typing indicator
function hideTypingIndicator() {
  isTyping = false;
  typingIndicator.style.display = 'none';
}

// Start a new chat
function newChat() {
  startNewConversation();
}

// TTS Toggle
function toggleTTS() {
  ttsEnabled = !ttsEnabled;
  speakerToggle.textContent = ttsEnabled ? '🔊' : '🔇';
  speakerToggle.classList.toggle('enabled', ttsEnabled);
  
  // Unlock audio on first interaction
  if (!audioUnlocked) {
    const silence = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=");
    silence.play().then(() => audioUnlocked = true).catch(() => {});
  }
}

// Tools Toggle (enables AI tool use like web search)
function toggleTools() {
  toolsEnabled = !toolsEnabled;
  searchToggleBtn.textContent = toolsEnabled ? '🔧' : '🔍';
  searchToggleBtn.classList.toggle('enabled', toolsEnabled);
}

// Recording functions
async function startRecording() {
  // Unlock audio on mic interaction
  if (!audioUnlocked) {
    const silence = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=");
    silence.play().then(() => audioUnlocked = true).catch(() => {});
  }
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Set up audio analysis for silence detection
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 512;
    
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = sendAudioToWhisper;
    
    mediaRecorder.start();
    isRecording = true;
    micBtn.classList.add('recording');
    
    // Start silence detection if in conversation mode
    if (conversationMode) {
      detectSilence();
    }
  } catch (err) {
    console.error('Mic access error:', err);
    alert('Could not access microphone');
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(track => track.stop());
    isRecording = false;
    micBtn.classList.remove('recording');
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }
}

async function sendAudioToWhisper() {
  const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });

  try {
    const response = await fetch(STT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: audioBlob
    });
    const data = await response.json();
    if (data.text) {
      messageInput.value = data.text;
      sendMessage();
    }
  } catch (err) {
    console.error('STT error:', err);
  }
}

async function speakText(text) {
  if (!ttsEnabled) return;

  // Clean markdown formatting
  text = text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#{1,6}\s?/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return;

  try {
    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    });

    if (!response.ok) {
      console.error('TTS request failed:', response.status);
      return;
    }

    const audioBlob = await response.blob();
    if (audioBlob.size === 0) {
      console.error('TTS returned empty audio');
      return;
    }

    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio();
    audio.src = audioUrl;

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      if (conversationMode && !isRecording) {
        startRecording();
      }
    };

    audio.onerror = (e) => {
      console.error('Audio playback error:', e);
      URL.revokeObjectURL(audioUrl);
    };

    await audio.play().catch(e => {
      console.error('Audio play failed:', e);
      const playBtn = document.createElement('button');
      playBtn.textContent = '▶️ Play Response';
      playBtn.className = 'play-response-btn';
      playBtn.onclick = () => {
        audio.play();
        playBtn.remove();
        audioUnlocked = true;
      };
      messagesContainer.appendChild(playBtn);
    });
  } catch (err) {
    console.error('TTS error:', err);
  }
}

// Silence detection for conversation mode
function detectSilence() {
  // Wait 2 seconds before starting silence detection
  setTimeout(() => {
  const bufferLength = analyser.fftSize;
  const dataArray = new Uint8Array(bufferLength);
  let silenceStart = null;
  const silenceThreshold = 5;  // Adjust if needed
  const silenceDuration = 4000; // 4 seconds of silence
  
  function checkAudio() {
    if (!isRecording || !conversationMode) return;
    
    analyser.getByteTimeDomainData(dataArray);
    
    // Calculate volume
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      const val = (dataArray[i] - 128) / 128;
      sum += val * val;
    }
    const volume = Math.sqrt(sum / bufferLength) * 100;
    
    if (volume < silenceThreshold) {
      if (!silenceStart) silenceStart = Date.now();
      else if (Date.now() - silenceStart > silenceDuration) {
        stopRecording();
        return;
      }
    } else {
      silenceStart = null;
    }
    
    requestAnimationFrame(checkAudio);
  }
  
  checkAudio();
  }, 2000);
}

// Toggle conversation mode
function toggleConversationMode() {
  conversationMode = !conversationMode;
  convoModeBtn.classList.toggle('active', conversationMode);
  convoModeBtn.textContent = conversationMode ? '🗣️' : '💬';

  // Also enable TTS when entering conversation mode
  if (conversationMode) {
    ttsEnabled = true;
    speakerToggle.textContent = '🔊';
    speakerToggle.classList.add('enabled');

    // Unlock audio
    const silence = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=");
    silence.play().then(() => audioUnlocked = true).catch(() => {});

    // Start listening
    startRecording();
  } else {
    stopRecording();
  }
}

// Settings Modal Functions
function openSettings() {
  settingsModal.style.display = 'flex';
}

function closeSettings() {
  settingsModal.style.display = 'none';
}

function loadSettings() {
  const claudeKey = localStorage.getItem('claudeApiKey') || '';
  const openaiKey = localStorage.getItem('openaiApiKey') || '';
  const grokKey = localStorage.getItem('grokApiKey') || '';
  const ollamaHost = localStorage.getItem('ollamaHost') || '';
  const squatchserveHost = localStorage.getItem('squatchserveHost') || '';
  const llamacppHost = localStorage.getItem('llamacppHost') || '';
  const searxngHost = localStorage.getItem('searxngHost') || '';

  document.getElementById('claudeApiKey').value = claudeKey;
  document.getElementById('openaiApiKey').value = openaiKey;
  document.getElementById('grokApiKey').value = grokKey;
  document.getElementById('ollamaHost').value = ollamaHost;
  document.getElementById('squatchserveHost').value = squatchserveHost;
  document.getElementById('llamacppHost').value = llamacppHost;
  document.getElementById('searxngHost').value = searxngHost;
}

async function saveSettingsHandler() {
  const claudeKey = document.getElementById('claudeApiKey').value.trim();
  const openaiKey = document.getElementById('openaiApiKey').value.trim();
  const grokKey = document.getElementById('grokApiKey').value.trim();
  const ollamaHost = document.getElementById('ollamaHost').value.trim();
  const squatchserveHost = document.getElementById('squatchserveHost').value.trim();
  const llamacppHost = document.getElementById('llamacppHost').value.trim();
  const searxngHost = document.getElementById('searxngHost').value.trim();

  // Save to localStorage
  if (claudeKey) {
    localStorage.setItem('claudeApiKey', claudeKey);
  } else {
    localStorage.removeItem('claudeApiKey');
  }

  if (openaiKey) {
    localStorage.setItem('openaiApiKey', openaiKey);
  } else {
    localStorage.removeItem('openaiApiKey');
  }

  if (grokKey) {
    localStorage.setItem('grokApiKey', grokKey);
  } else {
    localStorage.removeItem('grokApiKey');
  }

  if (ollamaHost) {
    localStorage.setItem('ollamaHost', ollamaHost);
  } else {
    localStorage.removeItem('ollamaHost');
  }

  if (squatchserveHost) {
    localStorage.setItem('squatchserveHost', squatchserveHost);
  } else {
    localStorage.removeItem('squatchserveHost');
  }

  if (llamacppHost) {
    localStorage.setItem('llamacppHost', llamacppHost);
  } else {
    localStorage.removeItem('llamacppHost');
  }

  if (searxngHost) {
    localStorage.setItem('searxngHost', searxngHost);
  } else {
    localStorage.removeItem('searxngHost');
  }

  // Close modal
  closeSettings();

  // Reload providers to update available options
  await loadProviders();

  addMessage('system', 'Settings saved successfully!');
}

function togglePasswordVisibility(event) {
  const button = event.currentTarget;
  const targetId = button.getAttribute('data-target');
  const input = document.getElementById(targetId);

  if (input.type === 'password') {
    input.type = 'text';
    button.textContent = '🙈';
  } else {
    input.type = 'password';
    button.textContent = '👁️';
  }
}

// ============ Conversation History Functions ============

// DOM elements for sidebar
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarNewChatBtn = document.getElementById('sidebar-new-chat-btn');
const conversationList = document.getElementById('conversation-list');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const mainContent = document.querySelector('.main-content');

// Set up sidebar event listeners
function setupSidebarListeners() {
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', toggleSidebar);
  }
  if (sidebarNewChatBtn) {
    sidebarNewChatBtn.addEventListener('click', startNewConversation);
  }
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebarOnMobile);
  }

  // Handle window resize
  window.addEventListener('resize', checkMobileView);
}

// Check if we're on mobile and adjust sidebar
function checkMobileView() {
  if (window.innerWidth <= 768) {
    sidebar?.classList.add('collapsed');
    mainContent?.classList.add('sidebar-collapsed');
  }
}

// Toggle sidebar visibility
function toggleSidebar() {
  if (window.innerWidth <= 768) {
    sidebar?.classList.toggle('open');
    sidebarOverlay?.classList.toggle('active');
  } else {
    sidebar?.classList.toggle('collapsed');
    mainContent?.classList.toggle('sidebar-collapsed');
    sidebarCollapsed = !sidebarCollapsed;
    localStorage.setItem('sidebarCollapsed', sidebarCollapsed);
  }
}

// Close sidebar on mobile when clicking overlay
function closeSidebarOnMobile() {
  sidebar?.classList.remove('open');
  sidebarOverlay?.classList.remove('active');
}

// Load all conversations from the server
async function loadConversations() {
  try {
    const response = await fetch('/api/conversations');
    if (!response.ok) {
      throw new Error('Failed to load conversations');
    }
    conversations = await response.json();
    renderConversationList();

    // If no current conversation, show welcome message
    if (!currentConversationId) {
      loadConversation(); // Load from session storage or show welcome
    }
  } catch (error) {
    console.error('Error loading conversations:', error);
    // Fall back to local session storage
    loadConversation();
  }
}

// Render the conversation list in the sidebar
function renderConversationList() {
  if (!conversationList) return;

  if (conversations.length === 0) {
    conversationList.innerHTML = '<div class="conversation-list-empty">No conversations yet.<br>Start a new chat!</div>';
    return;
  }

  conversationList.innerHTML = conversations.map(conv => {
    const isActive = conv.id === currentConversationId;
    const title = conv.title || 'New Conversation';
    const preview = conv.preview ? conv.preview.substring(0, 40) + '...' : '';
    const timestamp = formatRelativeTime(conv.updated_at);
    const model = conv.model_used ? conv.model_used.split(':')[0] : '';

    return `
      <div class="conversation-item ${isActive ? 'active' : ''}" data-id="${conv.id}">
        <div class="conversation-title">${escapeHtml(title)}</div>
        <div class="conversation-meta">
          <span class="conversation-timestamp">${timestamp}</span>
          ${model ? `<span class="conversation-model">${escapeHtml(model)}</span>` : ''}
        </div>
        <div class="conversation-actions">
          <button class="conversation-action-btn rename" title="Rename" data-id="${conv.id}">✏️</button>
          <button class="conversation-action-btn delete" title="Delete" data-id="${conv.id}">🗑️</button>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  conversationList.querySelectorAll('.conversation-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.conversation-action-btn')) {
        loadConversationById(item.dataset.id);
      }
    });
  });

  // Add action button handlers
  conversationList.querySelectorAll('.conversation-action-btn.rename').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      renameConversation(btn.dataset.id);
    });
  });

  conversationList.querySelectorAll('.conversation-action-btn.delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(btn.dataset.id);
    });
  });
}

// Format relative time (e.g., "2 hours ago", "Yesterday")
function formatRelativeTime(dateString) {
  if (!dateString) return '';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

// Load a specific conversation by ID
async function loadConversationById(id) {
  try {
    const response = await fetch(`/api/conversations/${id}`);
    if (!response.ok) {
      throw new Error('Failed to load conversation');
    }

    const data = await response.json();
    currentConversationId = id;

    // Convert messages to our format
    conversation = data.messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      id: msg.id
    }));

    // Update model if stored
    if (data.model_used && modelSelect) {
      const modelName = data.model_used;
      // Try to find and select the model
      const option = Array.from(modelSelect.options).find(opt => opt.value === modelName);
      if (option) {
        modelSelect.value = modelName;
        currentModel = modelName;
      }
    }

    renderMessages();
    renderConversationList(); // Update active state
    closeSidebarOnMobile();

  } catch (error) {
    console.error('Error loading conversation:', error);
    addMessage('error', 'Failed to load conversation');
  }
}

// Start a new conversation
function startNewConversation() {
  currentConversationId = null;
  conversation = [];
  lastAssistantMessageId = null;
  sessionStorage.removeItem('ollamaChatConversation');
  renderMessages();
  renderConversationList();
  messageInput.value = '';
  autoResizeInput();
  addMessage('system', 'Welcome! Start a new conversation.');
  closeSidebarOnMobile();
}

// Rename a conversation
async function renameConversation(id) {
  const conv = conversations.find(c => c.id === id);
  const currentTitle = conv?.title || 'New Conversation';
  const newTitle = prompt('Enter new title:', currentTitle);

  if (newTitle && newTitle.trim() !== currentTitle) {
    try {
      const response = await fetch(`/api/conversations/${id}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() })
      });

      if (!response.ok) {
        throw new Error('Failed to rename conversation');
      }

      // Update local state and re-render
      const idx = conversations.findIndex(c => c.id === id);
      if (idx !== -1) {
        conversations[idx].title = newTitle.trim();
        renderConversationList();
      }
    } catch (error) {
      console.error('Error renaming conversation:', error);
      alert('Failed to rename conversation');
    }
  }
}

// Delete a conversation
async function deleteConversation(id) {
  if (!confirm('Are you sure you want to delete this conversation?')) {
    return;
  }

  try {
    const response = await fetch(`/api/conversations/${id}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error('Failed to delete conversation');
    }

    // Remove from local state
    conversations = conversations.filter(c => c.id !== id);

    // If deleted current conversation, start new one
    if (id === currentConversationId) {
      startNewConversation();
    } else {
      renderConversationList();
    }
  } catch (error) {
    console.error('Error deleting conversation:', error);
    alert('Failed to delete conversation');
  }
}

// ============ SquatchServe Model Status Functions ============

// Fetch SquatchServe status (loaded models)
async function fetchSquatchserveStatus() {
  if (currentProvider !== 'squatchserve') {
    return;
  }

  try {
    const squatchserveHost = localStorage.getItem('squatchserveHost') || '';
    const url = squatchserveHost
      ? `/api/squatchserve/ps?host=${encodeURIComponent(squatchserveHost)}`
      : '/api/squatchserve/ps';

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch status');
    }

    const data = await response.json();
    updateModelStatusDisplay(data);
  } catch (error) {
    console.error('Error fetching SquatchServe status:', error);
    // Show error state but don't spam console
    if (modelStatusBar) {
      modelStatusText.textContent = 'SquatchServe unavailable';
      modelStatusText.classList.remove('loaded');
      unloadModelBtn.style.display = 'none';
    }
  }
}

// Update the model status display
function updateModelStatusDisplay(data) {
  if (!modelStatusBar) return;

  const loadedModels = data.models || [];
  const gpu = data.gpu || {};

  if (loadedModels.length > 0) {
    const model = loadedModels[0]; // Show first loaded model
    loadedSquatchserveModel = model.name;

    // Format VRAM info if available
    let vramInfo = '';
    if (model.vram && model.vram.used_gb) {
      vramInfo = ` (${model.vram.used_gb.toFixed(1)}GB VRAM)`;
    } else if (gpu.used_gb) {
      vramInfo = ` (${gpu.used_gb.toFixed(1)}/${gpu.total_gb.toFixed(1)}GB VRAM)`;
    }

    modelStatusText.textContent = `Loaded: ${model.name}${vramInfo}`;
    modelStatusText.classList.add('loaded');
    unloadModelBtn.style.display = 'inline-block';
  } else {
    loadedSquatchserveModel = null;
    modelStatusText.textContent = 'No model loaded';
    modelStatusText.classList.remove('loaded');
    unloadModelBtn.style.display = 'none';
  }
}

// Unload the currently loaded model
async function unloadSquatchserveModel() {
  if (!loadedSquatchserveModel) {
    return;
  }

  const modelName = loadedSquatchserveModel;
  unloadModelBtn.disabled = true;
  unloadModelBtn.textContent = 'Unloading...';

  try {
    const squatchserveHost = localStorage.getItem('squatchserveHost') || undefined;

    const response = await fetch('/api/squatchserve/unload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, squatchserveHost })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to unload model');
    }

    addMessage('system', `Model ${modelName} unloaded successfully.`);

    // Immediately refresh status
    await fetchSquatchserveStatus();
  } catch (error) {
    console.error('Error unloading model:', error);
    addMessage('error', `Failed to unload model: ${error.message}`);
  } finally {
    unloadModelBtn.disabled = false;
    unloadModelBtn.textContent = 'Unload';
  }
}

// Start polling for SquatchServe status
function startSquatchserveStatusPolling() {
  // Clear any existing interval
  stopSquatchserveStatusPolling();

  // Fetch immediately
  fetchSquatchserveStatus();

  // Then poll every 30 seconds
  squatchserveStatusInterval = setInterval(fetchSquatchserveStatus, 30000);
}

// Stop polling for SquatchServe status
function stopSquatchserveStatusPolling() {
  if (squatchserveStatusInterval) {
    clearInterval(squatchserveStatusInterval);
    squatchserveStatusInterval = null;
  }
}

// Show/hide model status bar based on provider
function updateModelStatusBarVisibility() {
  if (!modelStatusBar) return;

  if (currentProvider === 'squatchserve') {
    modelStatusBar.style.display = 'flex';
    startSquatchserveStatusPolling();
  } else {
    modelStatusBar.style.display = 'none';
    stopSquatchserveStatusPolling();
    loadedSquatchserveModel = null;
  }
}