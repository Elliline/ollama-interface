const { randomUUID } = require('crypto');
const { getSqliteDb, getClusterEmbeddingsTable } = require('./database');

/**
 * Generate embedding for text using Ollama's nomic-embed-text model
 * @param {string} text - Text to embed
 * @returns {Promise<number[]|null>} - Embedding vector or null on error
 */
async function generateEmbedding(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nomic-embed-text',
        prompt: text
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error('[Clusters] Embedding generation failed:', response.status);
      return null;
    }

    const data = await response.json();
    if (!data.embedding || !Array.isArray(data.embedding)) {
      return null;
    }
    // Return Float32Array to match database.js format (LanceDB expects float32 precision)
    return new Float32Array(data.embedding);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[Clusters] Embedding generation timeout');
    } else {
      console.error('[Clusters] Embedding generation error:', error.message);
    }
    return null;
  }
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} - Similarity score (0-1)
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Generate a cluster name using LLM (ollama/llamacpp only)
 * @param {string} fact - The fact to generate a name for
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {string} apiKey - API key (if needed)
 * @param {string} host - Host URL
 * @returns {Promise<string>} - Generated cluster name
 */
async function generateClusterName(fact, provider, model, apiKey, host) {
  const prompt = `Given this fact, generate a short 1-3 word category name for it. Return ONLY the category name, nothing else. Fact: ${fact}`;

  try {
    if (provider === 'ollama') {
      const response = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          prompt: prompt,
          stream: false
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.status}`);
      }

      const data = await response.json();
      return data.response?.trim()?.substring(0, 50) || extractNameFromFact(fact);
    } else if (provider === 'llamacpp') {
      const response = await fetch(`${host}/completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt,
          n_predict: 20,
          temperature: 0.3,
          stream: false
        })
      });

      if (!response.ok) {
        throw new Error(`Llama.cpp request failed: ${response.status}`);
      }

      const data = await response.json();
      return data.content?.trim()?.substring(0, 50) || extractNameFromFact(fact);
    } else {
      // For other providers, extract from fact text
      return extractNameFromFact(fact);
    }
  } catch (error) {
    console.error('[Clusters] Cluster name generation error:', error.message);
    return extractNameFromFact(fact);
  }
}

/**
 * Extract a simple name from fact text (fallback)
 * @param {string} fact - The fact text
 * @returns {string} - Extracted name
 */
function extractNameFromFact(fact) {
  // Remove common prefixes and take first few significant words
  const cleaned = fact
    .replace(/^(The user|User|I|My|This|That|There)\s+/i, '')
    .replace(/[.,!?;:].*$/, ''); // Remove from first punctuation

  const words = cleaned.split(/\s+/).filter(w => w.length > 2);
  return words.slice(0, 3).join(' ').substring(0, 50) || 'General';
}

/**
 * Create or strengthen a link between two clusters
 * @param {string} clusterA - First cluster ID
 * @param {string} clusterB - Second cluster ID
 * @param {Object} db - SQLite database instance
 */
function createOrStrengthenLink(clusterA, clusterB, db) {
  if (clusterA === clusterB) {
    return; // Don't link a cluster to itself
  }

  try {
    // Check if link exists (in either direction)
    const existingLink = db.prepare(`
      SELECT id, strength FROM cluster_links
      WHERE (cluster_a = ? AND cluster_b = ?)
         OR (cluster_a = ? AND cluster_b = ?)
    `).get(clusterA, clusterB, clusterB, clusterA);

    if (existingLink) {
      // Strengthen existing link (max 1.0)
      const newStrength = Math.min(1.0, existingLink.strength + 0.1);
      db.prepare('UPDATE cluster_links SET strength = ? WHERE id = ?')
        .run(newStrength, existingLink.id);
      console.log(`[Clusters] Strengthened link between clusters (${newStrength.toFixed(2)})`);
    } else {
      // Create new link
      const linkId = randomUUID();
      db.prepare(`
        INSERT INTO cluster_links (id, cluster_a, cluster_b, strength)
        VALUES (?, ?, ?, 0.5)
      `).run(linkId, clusterA, clusterB);
      console.log(`[Clusters] Created new link between clusters`);
    }
  } catch (error) {
    console.error('[Clusters] Error creating/strengthening link:', error.message);
  }
}

/**
 * Assign a fact to a cluster (existing or new)
 * @param {string} fact - The fact to cluster
 * @param {string} provider - LLM provider for cluster naming
 * @param {string} model - Model name
 * @param {string} apiKey - API key
 * @param {string} host - Host URL
 * @param {string} source - Source of the fact
 * @returns {Promise<Object>} - {clusterId, clusterName, isNew}
 */
async function assignToCluster(fact, provider, model, apiKey, host, source = 'conversation') {
  try {
    const db = getSqliteDb();
    if (!db) {
      console.error('[Clusters] Database not initialized');
      return { clusterId: null, clusterName: null, isNew: false };
    }

    // Generate embedding for the fact
    console.log('[Clusters] Generating embedding for fact');
    const embedding = await generateEmbedding(fact);
    if (!embedding) {
      console.error('[Clusters] Failed to generate embedding');
      return { clusterId: null, clusterName: null, isNew: false };
    }

    // Search for similar content in existing clusters
    const clusterTable = await getClusterEmbeddingsTable();
    let bestClusterId = null;
    let bestSimilarity = 0;
    const crossClusterCandidates = [];

    if (clusterTable) {
      console.log('[Clusters] Searching for similar cluster members');
      // Convert Float32Array to regular array for LanceDB compatibility
      const vectorArray = Array.from(embedding);
      const results = await clusterTable
        .search(vectorArray)
        .metricType('cosine')
        .limit(10)
        .execute();

      // Group by cluster and find best match
      const clusterScores = {};
      for (const result of results) {
        const similarity = 1 - (result._distance || 0); // Convert distance to similarity

        if (!clusterScores[result.cluster_id]) {
          clusterScores[result.cluster_id] = [];
        }
        clusterScores[result.cluster_id].push(similarity);

        // Track potential cross-cluster links
        if (similarity > 0.4) {
          crossClusterCandidates.push({
            clusterId: result.cluster_id,
            similarity: similarity
          });
        }
      }

      // Find cluster with highest average similarity
      for (const [clusterId, similarities] of Object.entries(clusterScores)) {
        const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
        if (avgSimilarity > bestSimilarity) {
          bestSimilarity = avgSimilarity;
          bestClusterId = clusterId;
        }
      }

      console.log(`[Clusters] Best cluster match: ${bestClusterId} (similarity: ${bestSimilarity.toFixed(3)})`);
    }

    let clusterId = bestClusterId;
    let clusterName = null;
    let isNew = false;

    // Create new cluster if no good match
    if (!bestClusterId || bestSimilarity <= 0.55) {
      console.log('[Clusters] Creating new cluster');
      clusterId = randomUUID();
      clusterName = await generateClusterName(fact, provider, model, apiKey, host);
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO memory_clusters (id, name, description, created_at, updated_at)
        VALUES (?, ?, '', ?, ?)
      `).run(clusterId, clusterName, now, now);

      isNew = true;
      console.log(`[Clusters] Created cluster: ${clusterName}`);
    } else {
      // Get existing cluster name
      const cluster = db.prepare('SELECT name FROM memory_clusters WHERE id = ?').get(clusterId);
      clusterName = cluster?.name || 'Unknown';

      // Update cluster timestamp
      db.prepare('UPDATE memory_clusters SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), clusterId);
    }

    // Insert into cluster_members
    const memberId = randomUUID();
    db.prepare(`
      INSERT INTO cluster_members (id, cluster_id, content, source, importance, created_at)
      VALUES (?, ?, ?, ?, 0.5, ?)
    `).run(memberId, clusterId, fact, source, new Date().toISOString());

    console.log(`[Clusters] Added fact to cluster: ${clusterName}`);

    // Add embedding to LanceDB
    if (clusterTable) {
      // Convert Float32Array to regular array for LanceDB compatibility
      const vectorForStorage = Array.from(embedding);
      await clusterTable.add([{
        id: randomUUID(),
        member_id: memberId,
        cluster_id: clusterId,
        content: fact,
        vector: vectorForStorage
      }]);
    }

    // Cross-cluster linking — link when fact is similar to members in other clusters
    if (crossClusterCandidates.length > 0) {
      const uniqueClusters = [...new Set(crossClusterCandidates.map(c => c.clusterId))];
      const otherClusters = uniqueClusters.filter(id => id !== clusterId);

      if (otherClusters.length > 0) {
        console.log(`[Clusters] Creating/strengthening ${otherClusters.length} cross-cluster link(s)`);
        for (const otherClusterId of otherClusters) {
          createOrStrengthenLink(clusterId, otherClusterId, db);
        }
      }
    }

    return { clusterId, clusterName, isNew };
  } catch (error) {
    console.error('[Clusters] Error in assignToCluster:', error);
    return { clusterId: null, clusterName: null, isNew: false };
  }
}

/**
 * Search clusters for relevant content
 * @param {string} query - Search query
 * @param {number} limit - Max number of clusters to return
 * @returns {Promise<Array>} - Array of cluster results with members and linked content
 */
async function searchClusters(query, limit = 3) {
  try {
    const db = getSqliteDb();
    if (!db) {
      console.log('[Clusters] Database not initialized');
      return [];
    }

    // Generate embedding for query
    const embedding = await generateEmbedding(query);
    if (!embedding) {
      console.error('[Clusters] Failed to generate query embedding');
      return [];
    }

    const clusterTable = await getClusterEmbeddingsTable();
    if (!clusterTable) {
      console.log('[Clusters] Cluster embeddings table not available');
      return [];
    }

    // Search for similar content
    console.log('[Clusters] Searching for relevant clusters');
    // Convert Float32Array to regular array for LanceDB compatibility
    const vectorArray = Array.from(embedding);
    const results = await clusterTable
      .search(vectorArray)
      .metricType('cosine')
      .limit(20)
      .execute();

    // Group by cluster and rank
    const clusterScores = {};
    for (const result of results) {
      const similarity = 1 - (result._distance || 0);
      if (!clusterScores[result.cluster_id]) {
        clusterScores[result.cluster_id] = {
          maxSimilarity: similarity,
          avgSimilarity: 0,
          count: 0
        };
      }
      const score = clusterScores[result.cluster_id];
      score.maxSimilarity = Math.max(score.maxSimilarity, similarity);
      score.avgSimilarity += similarity;
      score.count++;
    }

    // Calculate averages and sort
    const rankedClusters = Object.entries(clusterScores)
      .map(([clusterId, score]) => ({
        clusterId,
        score: score.avgSimilarity / score.count
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    console.log(`[Clusters] Found ${rankedClusters.length} relevant clusters`);

    // Build results with members and linked content
    const clusterResults = [];
    for (const { clusterId } of rankedClusters) {
      // Get cluster info
      const cluster = db.prepare(`
        SELECT id, name, description
        FROM memory_clusters
        WHERE id = ?
      `).get(clusterId);

      if (!cluster) continue;

      // Get all members
      const members = db.prepare(`
        SELECT content, importance
        FROM cluster_members
        WHERE cluster_id = ?
        ORDER BY importance DESC, created_at DESC
      `).all(clusterId);

      // Get linked clusters
      const linkedClusters = db.prepare(`
        SELECT
          CASE
            WHEN cl.cluster_a = ? THEN cl.cluster_b
            ELSE cl.cluster_a
          END as linked_cluster_id,
          cl.strength
        FROM cluster_links cl
        WHERE (cl.cluster_a = ? OR cl.cluster_b = ?)
          AND cl.strength > 0.3
        ORDER BY cl.strength DESC
      `).all(clusterId, clusterId, clusterId);

      // Get members from linked clusters
      const linkedMembers = [];
      for (const link of linkedClusters) {
        const linkCluster = db.prepare('SELECT name FROM memory_clusters WHERE id = ?')
          .get(link.linked_cluster_id);

        const linkMembers = db.prepare(`
          SELECT content
          FROM cluster_members
          WHERE cluster_id = ?
          ORDER BY importance DESC, created_at DESC
          LIMIT 3
        `).all(link.linked_cluster_id);

        for (const member of linkMembers) {
          linkedMembers.push({
            content: member.content,
            clusterName: linkCluster?.name || 'Unknown',
            linkStrength: link.strength
          });
        }
      }

      clusterResults.push({
        cluster: {
          id: cluster.id,
          name: cluster.name,
          description: cluster.description
        },
        members: members.map(m => ({
          content: m.content,
          importance: m.importance
        })),
        linkedMembers: linkedMembers
      });
    }

    return clusterResults;
  } catch (error) {
    console.error('[Clusters] Error in searchClusters:', error);
    return [];
  }
}

/**
 * Get all clusters with member counts
 * @returns {Array} - Array of clusters with metadata
 */
function getClusters() {
  try {
    const db = getSqliteDb();
    if (!db) {
      return [];
    }

    const clusters = db.prepare(`
      SELECT mc.*, COUNT(cm.id) as member_count
      FROM memory_clusters mc
      LEFT JOIN cluster_members cm ON mc.id = cm.cluster_id
      GROUP BY mc.id
      ORDER BY mc.updated_at DESC
    `).all();

    return clusters;
  } catch (error) {
    console.error('[Clusters] Error in getClusters:', error);
    return [];
  }
}

/**
 * Get a specific cluster with all members and linked clusters
 * @param {string} id - Cluster ID
 * @returns {Object|null} - Cluster details or null
 */
function getCluster(id) {
  try {
    const db = getSqliteDb();
    if (!db) {
      return null;
    }

    const cluster = db.prepare(`
      SELECT * FROM memory_clusters WHERE id = ?
    `).get(id);

    if (!cluster) {
      return null;
    }

    // Get members
    const members = db.prepare(`
      SELECT * FROM cluster_members
      WHERE cluster_id = ?
      ORDER BY importance DESC, created_at DESC
    `).all(id);

    // Get linked clusters
    const linkedClusters = db.prepare(`
      SELECT
        mc.*,
        cl.strength
      FROM cluster_links cl
      JOIN memory_clusters mc ON mc.id = CASE
        WHEN cl.cluster_a = ? THEN cl.cluster_b
        ELSE cl.cluster_a
      END
      WHERE cl.cluster_a = ? OR cl.cluster_b = ?
      ORDER BY cl.strength DESC
    `).all(id, id, id);

    return {
      ...cluster,
      members,
      linkedClusters
    };
  } catch (error) {
    console.error('[Clusters] Error in getCluster:', error);
    return null;
  }
}

module.exports = {
  assignToCluster,
  searchClusters,
  getClusters,
  getCluster,
  generateEmbedding,
  cosineSimilarity
};
