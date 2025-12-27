/**
 * Database layer for chat history and semantic memory
 * Combines SQLite (structured data) and LanceDB (vector embeddings)
 */

const Database = require('better-sqlite3');
const lancedb = require('vectordb');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

// Database paths
const DATA_DIR = path.join(__dirname, '../data');
const SQLITE_PATH = path.join(DATA_DIR, 'chat.db');
const LANCEDB_PATH = path.join(DATA_DIR, 'lancedb');

// Ensure data directories exist
function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(LANCEDB_PATH)) {
    fs.mkdirSync(LANCEDB_PATH, { recursive: true });
  }
}

// Global database instances
let sqliteDb = null;
let vectorDb = null;
let embeddingsTable = null;

// ============ SQLite Setup ============

/**
 * Initialize SQLite database with schema
 * @returns {Database} SQLite database instance
 */
function initDatabase() {
  try {
    ensureDirectories();

    // Initialize SQLite
    sqliteDb = new Database(SQLITE_PATH);
    sqliteDb.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
    sqliteDb.pragma('foreign_keys = ON'); // Enable foreign key constraints

    // Create conversations table
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        model_used TEXT
      )
    `);

    // Create messages table
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        model TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for performance
    sqliteDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
      ON messages(conversation_id)
    `);

    sqliteDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
      ON conversations(updated_at DESC)
    `);

    console.log('SQLite database initialized successfully');
    return sqliteDb;
  } catch (error) {
    console.error('Failed to initialize SQLite database:', error.message);
    throw error;
  }
}

/**
 * Get list of all conversations with preview
 * @returns {Array} Array of conversation objects
 */
function getConversations() {
  try {
    if (!sqliteDb) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    const stmt = sqliteDb.prepare(`
      SELECT
        c.id,
        c.title,
        c.created_at,
        c.updated_at,
        c.model_used,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY timestamp ASC LIMIT 1) as preview
      FROM conversations c
      ORDER BY c.updated_at DESC
    `);

    return stmt.all();
  } catch (error) {
    console.error('Error fetching conversations:', error.message);
    throw error;
  }
}

/**
 * Get full conversation with all messages
 * @param {string} id - Conversation ID
 * @returns {Object|null} Conversation object with messages array
 */
function getConversation(id) {
  try {
    if (!sqliteDb) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    // Get conversation metadata
    const conversationStmt = sqliteDb.prepare(`
      SELECT id, title, created_at, updated_at, model_used
      FROM conversations
      WHERE id = ?
    `);
    const conversation = conversationStmt.get(id);

    if (!conversation) {
      return null;
    }

    // Get all messages for this conversation
    const messagesStmt = sqliteDb.prepare(`
      SELECT id, conversation_id, role, content, timestamp, model
      FROM messages
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
    `);
    const messages = messagesStmt.all(id);

    return {
      ...conversation,
      messages
    };
  } catch (error) {
    console.error('Error fetching conversation:', error.message);
    throw error;
  }
}

/**
 * Create a new conversation
 * @param {string} title - Conversation title
 * @param {string} model_used - Model identifier
 * @returns {string} New conversation ID
 */
function createConversation(title, model_used) {
  try {
    if (!sqliteDb) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    const id = randomUUID();
    const stmt = sqliteDb.prepare(`
      INSERT INTO conversations (id, title, model_used)
      VALUES (?, ?, ?)
    `);

    stmt.run(id, title, model_used);
    return id;
  } catch (error) {
    console.error('Error creating conversation:', error.message);
    throw error;
  }
}

/**
 * Delete a conversation and all its messages
 * @param {string} id - Conversation ID
 */
function deleteConversation(id) {
  try {
    if (!sqliteDb) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    const stmt = sqliteDb.prepare('DELETE FROM conversations WHERE id = ?');
    stmt.run(id);

    // Also delete vector embeddings
    deleteConversationEmbeddings(id).catch(err => {
      console.error('Error deleting embeddings:', err.message);
    });
  } catch (error) {
    console.error('Error deleting conversation:', error.message);
    throw error;
  }
}

/**
 * Update conversation title
 * @param {string} id - Conversation ID
 * @param {string} title - New title
 */
function updateConversationTitle(id, title) {
  try {
    if (!sqliteDb) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    const stmt = sqliteDb.prepare(`
      UPDATE conversations
      SET title = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(title, id);
  } catch (error) {
    console.error('Error updating conversation title:', error.message);
    throw error;
  }
}

/**
 * Add a message to a conversation
 * @param {string} conversation_id - Conversation ID
 * @param {string} role - Message role (user/assistant/system)
 * @param {string} content - Message content
 * @param {string} model - Model used (optional)
 * @returns {string} New message ID
 */
function addMessage(conversation_id, role, content, model = null) {
  try {
    if (!sqliteDb) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    const id = randomUUID();
    const stmt = sqliteDb.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, model)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, conversation_id, role, content, model);

    // Update conversation's updated_at timestamp
    updateConversationTimestamp(conversation_id);

    return id;
  } catch (error) {
    console.error('Error adding message:', error.message);
    throw error;
  }
}

/**
 * Update conversation's updated_at timestamp
 * @param {string} id - Conversation ID
 */
function updateConversationTimestamp(id) {
  try {
    if (!sqliteDb) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    const stmt = sqliteDb.prepare(`
      UPDATE conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(id);
  } catch (error) {
    console.error('Error updating conversation timestamp:', error.message);
    throw error;
  }
}

// ============ LanceDB (Vector Store) Setup ============

/**
 * Initialize LanceDB for vector embeddings
 * @returns {Promise<Object>} LanceDB table instance
 */
async function initVectorStore() {
  try {
    ensureDirectories();

    // Connect to LanceDB
    vectorDb = await lancedb.connect(LANCEDB_PATH);

    // Check if table exists
    const tableNames = await vectorDb.tableNames();

    if (tableNames.includes('message_embeddings')) {
      // Open existing table
      embeddingsTable = await vectorDb.openTable('message_embeddings');
      console.log('LanceDB: Opened existing message_embeddings table');
    } else {
      // Create new table with schema
      // Note: We need at least one record to create the table with schema
      // Use regular array for LanceDB compatibility
      const sampleData = [{
        id: randomUUID(),
        message_id: 'sample',
        conversation_id: 'sample',
        text: 'Sample initialization text',
        role: 'system',
        vector: Array(768).fill(0) // nomic-embed-text produces 768-dim vectors
      }];

      embeddingsTable = await vectorDb.createTable('message_embeddings', sampleData);

      // Delete the sample record
      await embeddingsTable.delete('id = "' + sampleData[0].id + '"');

      console.log('LanceDB: Created new message_embeddings table');
    }

    return embeddingsTable;
  } catch (error) {
    console.error('Failed to initialize LanceDB:', error.message);
    throw error;
  }
}

/**
 * Generate embedding using Ollama's nomic-embed-text model
 * @param {string} text - Text to embed
 * @returns {Promise<Float32Array>} Embedding vector
 */
async function generateEmbedding(text) {
  try {
    const response = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nomic-embed-text',
        prompt: text
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding API returned ${response.status}`);
    }

    const data = await response.json();

    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error('Invalid embedding response format');
    }

    return new Float32Array(data.embedding);
  } catch (error) {
    console.error('Error generating embedding:', error.message);
    throw error;
  }
}

/**
 * Add embedding to vector store
 * @param {string} message_id - Message ID from SQLite
 * @param {string} conversation_id - Conversation ID
 * @param {string} text - Message text
 * @param {string} role - Message role
 * @param {Float32Array} vector - Embedding vector
 * @returns {Promise<void>}
 */
async function addEmbedding(message_id, conversation_id, text, role, vector) {
  try {
    if (!embeddingsTable) {
      throw new Error('Vector store not initialized. Call initVectorStore() first.');
    }

    // Convert Float32Array to regular array for LanceDB compatibility
    const vectorArray = Array.from(vector);

    const record = {
      id: randomUUID(),
      message_id,
      conversation_id,
      text,
      role,
      vector: vectorArray
    };

    await embeddingsTable.add([record]);
  } catch (error) {
    console.error('Error adding embedding:', error.message);
    throw error;
  }
}

/**
 * Search for similar messages across conversations
 * @param {Float32Array} vector - Query vector
 * @param {string} excludeConversationId - Conversation ID to exclude from results
 * @param {number} limit - Maximum number of results
 * @param {number} threshold - Similarity threshold (0-1, higher is more similar)
 * @returns {Promise<Array>} Array of similar messages
 */
async function searchSimilar(vector, excludeConversationId, limit = 5, threshold = 0.7) {
  try {
    if (!embeddingsTable) {
      throw new Error('Vector store not initialized. Call initVectorStore() first.');
    }

    // Convert Float32Array to regular array for LanceDB compatibility
    const vectorArray = Array.from(vector);

    // Perform vector search with cosine distance metric
    // Cosine distance returns values 0-1 where 0 = identical, 1 = opposite
    const results = await embeddingsTable
      .search(vectorArray)
      .metricType('cosine')
      .limit(limit * 2) // Get more results to filter
      .execute();

    // Filter out current conversation and apply threshold
    const filtered = results
      .filter(result => {
        // Exclude current conversation
        if (result.conversation_id === excludeConversationId) {
          return false;
        }
        // Apply similarity threshold
        // Convert cosine distance to similarity: similarity = 1 - distance
        const similarity = 1 - result._distance;
        return similarity >= threshold;
      })
      .slice(0, limit)
      .map(result => ({
        message_id: result.message_id,
        conversation_id: result.conversation_id,
        text: result.text,
        role: result.role,
        similarity: 1 - result._distance
      }));

    return filtered;
  } catch (error) {
    console.error('Error searching similar messages:', error.message);
    // Return empty array on error to not break the application
    return [];
  }
}

/**
 * Delete all embeddings for a conversation
 * @param {string} conversation_id - Conversation ID
 * @returns {Promise<void>}
 */
async function deleteConversationEmbeddings(conversation_id) {
  try {
    if (!embeddingsTable) {
      // If table not initialized, silently skip
      return;
    }

    await embeddingsTable.delete(`conversation_id = "${conversation_id}"`);
  } catch (error) {
    console.error('Error deleting conversation embeddings:', error.message);
    // Don't throw - embedding deletion is not critical
  }
}

// ============ Exports ============

module.exports = {
  // Initialization
  initDatabase,
  initVectorStore,

  // SQLite functions
  getConversations,
  getConversation,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  addMessage,
  updateConversationTimestamp,

  // Vector store functions
  generateEmbedding,
  addEmbedding,
  searchSimilar,
  deleteConversationEmbeddings
};
