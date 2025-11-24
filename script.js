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

// State variables
let currentModel = '';
let conversation = [];
let isTyping = false;
let lastAssistantMessageId = null;

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
    renderMessages();
    
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
  if (lastAssistantMessageId !== null) {
    const messageIndex = conversation.findIndex(msg => msg.id === lastAssistantMessageId);
    if (messageIndex !== -1) {
      conversation[messageIndex].content = content;
      renderMessages();
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
