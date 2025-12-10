/**
 * Ollama Chat Interface
 * A web-based interface for interacting with local AI models
 */

// DOM Elements
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

// State variables
let currentModel = '';
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
const TTS_URL = 'http://192.168.1.181:5050/tts';
const STT_URL = 'http://192.168.1.181:5051/transcribe';   

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
  loadModels();
  loadConversation();
  setupEventListeners();
});

// Load available models from Ollama
async function loadModels() {
  try {
    const response = await fetch('/api/tags');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    const models = data.models || [];
    
    modelSelect.innerHTML = '<option value="">Select a model</option>';
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.name;
      option.textContent = model.name;
      modelSelect.appendChild(option);
    });
    
    // If we have a saved model, select it
    if (localStorage.getItem('selectedModel')) {
      modelSelect.value = localStorage.getItem('selectedModel');
      currentModel = localStorage.getItem('selectedModel');
    }
  } catch (error) {
    console.error('Error loading models:', error);
    messagesContainer.innerHTML = '<div class="error-message">Failed to load models. Make sure Ollama is running.</div>';
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
  if (!message || !currentModel) return;
  
  // Add user message to conversation
  addMessage('user', message);
  messageInput.value = '';
  autoResizeInput();
  
  // Show typing indicator
  showTypingIndicator();
  
  try {
    // Send message to Ollama API
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: currentModel,
        messages: conversation.filter(msg => msg.role === 'user' || msg.role === 'assistant').map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        stream: true
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    // Handle streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    
    // Create a new assistant message for streaming
const assistantMessageId = Date.now();
conversation.push({
  role: 'assistant',
  content: '',
  id: assistantMessageId
});
lastAssistantMessageId = assistantMessageId;

// Create the DOM element directly instead of re-rendering everything
streamingMessageElement = document.createElement('div');
streamingMessageElement.classList.add('message', 'assistant');
streamingMessageElement.innerHTML = '<div class="message-content"></div>';
messagesContainer.appendChild(streamingMessageElement);
chatContainer.scrollTop = chatContainer.scrollHeight;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.trim() === '') continue;
        
        try {
          const data = JSON.parse(line);
          if (data.message && data.message.content) {
            fullResponse += data.message.content;
            updateLastMessage(fullResponse);
          }
        } catch (e) {
          console.error('Error parsing JSON:', e);
        }
      }
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
    addMessage('error', 'Failed to send message. Check if Ollama is running and the model is available.');
  } finally {
    hideTypingIndicator();
  }
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
  // Simple markdown-like formatting
  return content
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
  console.log('stopRecording called');
  console.trace();  // Shows what called this function
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
  const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.wav');
  
  try {
    const response = await fetch(STT_URL, {
      method: 'POST',
      body: formData
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
  
  try {
    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    });
    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    
    audio.onended = () => {
      if (conversationMode && !isRecording) {
        startRecording();
      }
    };
    
    audio.play().catch(e => {
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