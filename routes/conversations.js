/**
 * Conversation Management API Routes
 * Handles CRUD operations for chat conversations
 */

const express = require('express');
const router = express.Router();

// Import database functions (will be implemented in db/database.js)
const {
  getConversations,
  getConversation,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  deleteConversationEmbeddings
} = require('../db/database.js');

/**
 * GET /api/conversations
 * List all conversations for sidebar
 * Returns: [{ id, title, updated_at, preview }]
 * preview = first 50 chars of first user message
 */
router.get('/', (req, res) => {
  try {
    const conversations = getConversations();
    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error.message);
    res.status(500).json({
      error: 'Failed to fetch conversations',
      details: error.message
    });
  }
});

/**
 * POST /api/conversations
 * Create a new conversation
 * Body: { model_used }
 * Returns: { id, title, created_at, model_used }
 */
router.post('/', (req, res) => {
  try {
    const { model_used } = req.body;

    // Validate required field
    if (!model_used || typeof model_used !== 'string') {
      return res.status(400).json({
        error: 'model_used is required and must be a string'
      });
    }

    // Validate model name length
    if (model_used.length > 100) {
      return res.status(400).json({
        error: 'model_used exceeds maximum length of 100 characters'
      });
    }

    const id = createConversation(null, model_used);
    res.status(201).json({ id, title: null, model_used });
  } catch (error) {
    console.error('Error creating conversation:', error.message);
    res.status(500).json({
      error: 'Failed to create conversation',
      details: error.message
    });
  }
});

/**
 * GET /api/conversations/:id
 * Get full conversation with all messages
 * Returns: { id, title, created_at, updated_at, model_used, messages: [{id, role, content, timestamp, model}] }
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format (UUID)
    if (!id || typeof id !== 'string' || id.length > 50) {
      return res.status(400).json({
        error: 'Invalid conversation ID'
      });
    }

    const conversation = getConversation(id);

    if (!conversation) {
      return res.status(404).json({
        error: 'Conversation not found'
      });
    }

    res.json(conversation);
  } catch (error) {
    console.error('Error fetching conversation:', error.message);
    res.status(500).json({
      error: 'Failed to fetch conversation',
      details: error.message
    });
  }
});

/**
 * DELETE /api/conversations/:id
 * Delete a conversation and its embeddings
 * Returns: { success: true }
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format (UUID)
    if (!id || typeof id !== 'string' || id.length > 50) {
      return res.status(400).json({
        error: 'Invalid conversation ID'
      });
    }

    // Check if conversation exists
    const existing = getConversation(id);
    if (!existing) {
      return res.status(404).json({
        error: 'Conversation not found'
      });
    }

    // Delete embeddings first (if they exist)
    try {
      await deleteConversationEmbeddings(id);
    } catch (embeddingError) {
      // Log but don't fail if embeddings deletion fails
      console.warn('Warning: Failed to delete embeddings for conversation', id, ':', embeddingError.message);
    }

    // Delete the conversation
    deleteConversation(id);
    const deleted = true;

    if (!deleted) {
      return res.status(404).json({
        error: 'Conversation not found'
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting conversation:', error.message);
    res.status(500).json({
      error: 'Failed to delete conversation',
      details: error.message
    });
  }
});

/**
 * PUT /api/conversations/:id/title
 * Rename a conversation
 * Body: { title }
 * Returns: { success: true, title }
 */
router.put('/:id/title', async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;

    // Validate ID format (UUID)
    if (!id || typeof id !== 'string' || id.length > 50) {
      return res.status(400).json({
        error: 'Invalid conversation ID'
      });
    }

    // Validate title
    if (!title || typeof title !== 'string') {
      return res.status(400).json({
        error: 'title is required and must be a string'
      });
    }

    if (title.trim().length === 0) {
      return res.status(400).json({
        error: 'title cannot be empty'
      });
    }

    if (title.length > 255) {
      return res.status(400).json({
        error: 'title exceeds maximum length of 255 characters'
      });
    }

    // Check if conversation exists
    const existing = getConversation(id);
    if (!existing) {
      return res.status(404).json({
        error: 'Conversation not found'
      });
    }

    updateConversationTitle(id, title.trim());

    res.json({ success: true, title: title.trim() });
  } catch (error) {
    console.error('Error updating conversation title:', error.message);
    res.status(500).json({
      error: 'Failed to update conversation title',
      details: error.message
    });
  }
});

module.exports = router;
