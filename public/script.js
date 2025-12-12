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
const speakerToggle = document.getElementById('speakerToggle');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeModal = document.getElementById('closeModal');
const saveSettings = document.getElementById('saveSettings');

// State variables
let currentProvider = '';
let currentModel = '';
let providers = [];
let conversation = [];
let isTyping = false;
let lastAssistantMessageId = null;
let streamingMessageElement = null;
let pendingContent = null;
let animationFrameId = null;
let ttsEnabled = false;
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let conversationMode = false;
let silenceTimer = null;
let audioContext = null;
let analyser = null;
let audioUnlocked = false;
const TTS_URL = '/api/tts';
const STT_URL = '/api/stt';   

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
  loadProviders();
  loadConversation();
  setupEventListeners();
  loadSettings();
});

// Load available providers
async function loadProviders() {
  try {
    const hasClaudeKey = !!localStorage.getItem('claudeApiKey');
    const hasGrokKey = !!localStorage.getItem('grokApiKey');

    const response = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hasClaudeKey, hasGrokKey })
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
      option.textContent = provider.name;
      providerSelect.appendChild(option);
    });

    // Restore saved provider
    const savedProvider = localStorage.getItem('selectedProvider');
    if (savedProvider) {
      providerSelect.value = savedProvider;
      currentProvider = savedProvider;
      await loadModelsForProvider(savedProvider);
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
    addMessage('error', `Failed to load models for ${providerId}. ${providerId === 'ollama' ? 'Make sure Ollama is running.' : 'Check your API key in settings.'}`);
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

    if (currentProvider === 'ollama') {
      // Send to Ollama
      const ollamaHost = localStorage.getItem('ollamaHost') || undefined;
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel,
          messages: conversationMessages,
          stream: true,
          ollamaHost
        })
      });
    } else if (currentProvider === 'claude') {
      // Send to Claude
      const apiKey = localStorage.getItem('claudeApiKey');
      if (!apiKey) {
        throw new Error('Claude API key not found. Please add it in settings.');
      }
      response = await fetch('/api/claude/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel,
          messages: conversationMessages,
          apiKey
        })
      });
    } else if (currentProvider === 'grok') {
      // Send to Grok
      const apiKey = localStorage.getItem('grokApiKey');
      if (!apiKey) {
        throw new Error('Grok API key not found. Please add it in settings.');
      }
      response = await fetch('/api/grok/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel,
          messages: conversationMessages,
          apiKey
        })
      });
    } else {
      throw new Error('Unknown provider selected');
    }

    // SECURITY FIX: Check if response exists before accessing properties
    if (!response) {
      throw new Error('No response received from provider');
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
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
    if (currentProvider === 'ollama') {
      fullResponse = await processOllamaStream(response);
    } else if (currentProvider === 'claude') {
      fullResponse = await processClaudeStream(response);
    } else if (currentProvider === 'grok') {
      fullResponse = await processGrokStream(response);
    }

    // Update the assistant message with the complete response
    const assistantMessageIndex = conversation.findIndex(msg => msg.id === assistantMessageId);
    if (assistantMessageIndex !== -1) {
      conversation[assistantMessageIndex].content = fullResponse;
    }

    saveConversation();
    speakText(fullResponse);
    streamingMessageElement = null;
    pendingContent = null;
    animationFrameId = null;

  } catch (error) {
    console.error('Error sending message:', error);
    addMessage('error', `Failed to send message: ${error.message}`);
  } finally {
    hideTypingIndicator();
  }
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
            if (parsed.choices?.[0]?.delta?.content) {
              fullResponse += parsed.choices[0].delta.content;
              updateLastMessage(fullResponse);
            }
          } catch (e) {
            console.error('Error parsing Grok SSE:', e);
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
  conversation = [];
  lastAssistantMessageId = null;
  sessionStorage.removeItem('ollamaChatConversation');
  renderMessages();
  messageInput.value = '';
  autoResizeInput();
  addMessage('system', 'Welcome to Ollama Chat! Select a model and start chatting.');
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
  const grokKey = localStorage.getItem('grokApiKey') || '';
  const ollamaHost = localStorage.getItem('ollamaHost') || '';

  document.getElementById('claudeApiKey').value = claudeKey;
  document.getElementById('grokApiKey').value = grokKey;
  document.getElementById('ollamaHost').value = ollamaHost;
}

async function saveSettingsHandler() {
  const claudeKey = document.getElementById('claudeApiKey').value.trim();
  const grokKey = document.getElementById('grokApiKey').value.trim();
  const ollamaHost = document.getElementById('ollamaHost').value.trim();

  // Save to localStorage
  if (claudeKey) {
    localStorage.setItem('claudeApiKey', claudeKey);
  } else {
    localStorage.removeItem('claudeApiKey');
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