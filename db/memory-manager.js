/**
 * Memory Manager Heartbeat
 * Scheduled background job that maintains and optimizes the memory system.
 * Runs every 2 hours (configurable) with 4 maintenance tasks:
 *   A) auditClusters  — LLM-driven cluster merge/move/split
 *   B) cleanupFacts   — LLM-driven fact dedup/reword/merge in MEMORY.md
 *   C) summarizeDailyLogs — archive daily logs older than 7 days
 *   D) maintainLinks  — prune weak links, strengthen co-occurring ones
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { getSqliteDb, getClusterEmbeddingsTable } = require('./database');
const memoryClusters = require('./memory-clusters');
const factExtractor = require('./fact-extractor');

const MEMORY_DIR = path.join(__dirname, '../data/memory');
const DAILY_DIR = path.join(MEMORY_DIR, 'daily');
const ARCHIVE_DIR = path.join(DAILY_DIR, 'archive');

let heartbeatTimer = null;
let isRunning = false;

// ============ LLM Helper ============

/**
 * Call an LLM with system + user prompts.
 * Fallback chain: llamacpp/scout → ollama/qwen3:14b → ollama/gemma3:27b
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<{content: string, provider: string}>}
 */
async function callLLM(systemPrompt, userPrompt) {
  const llamacppHost = process.env.LLAMACPP_HOST || 'http://localhost:8080';
  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const providers = [
    {
      name: 'llamacpp/scout',
      url: `${llamacppHost}/v1/chat/completions`,
      body: { messages, stream: false },
      extract: (data) => data.choices?.[0]?.message?.content || ''
    },
    {
      name: 'ollama/qwen3:14b',
      url: `${ollamaHost}/api/chat`,
      body: { model: 'qwen3:14b', messages, stream: false },
      extract: (data) => data.message?.content || ''
    },
    {
      name: 'ollama/gemma3:27b',
      url: `${ollamaHost}/api/chat`,
      body: { model: 'gemma3:27b', messages, stream: false },
      extract: (data) => data.message?.content || ''
    }
  ];

  let lastError = null;

  for (const provider of providers) {
    try {
      console.log(`[Heartbeat] Trying ${provider.name} → ${provider.url}`);
      const response = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(provider.body),
        signal: AbortSignal.timeout(60000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const content = provider.extract(data);
      if (content) {
        console.log(`[Heartbeat] ${provider.name} responded (${content.length} chars)`);
        return { content, provider: provider.name };
      }
      throw new Error('Empty response');
    } catch (err) {
      console.log(`[Heartbeat] ${provider.name} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(`All LLM providers failed. Last error: ${lastError?.message}`);
}

/**
 * Parse a JSON object from LLM response text (handles markdown code blocks)
 * @param {string} text - LLM response
 * @returns {Object|null}
 */
function parseJSON(text) {
  try {
    // Try to find JSON object or array in the response
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);

    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);

    return null;
  } catch {
    return null;
  }
}

// ============ Task A: Audit Clusters ============

async function auditClusters() {
  console.log('[Heartbeat] Task A: Auditing clusters...');
  const results = { merges: 0, moves: 0, splits: 0 };

  try {
    const clusters = memoryClusters.getClusters();
    if (clusters.length < 2) {
      console.log('[Heartbeat] Not enough clusters to audit');
      return results;
    }

    // Build cluster summary for LLM
    const clusterSummaries = [];
    for (const cluster of clusters) {
      const detail = memoryClusters.getCluster(cluster.id);
      if (!detail) continue;
      const memberTexts = detail.members.map(m => m.content).join('\n  - ');
      const linked = detail.linkedClusters.map(l => l.name).join(', ');
      clusterSummaries.push(
        `Cluster "${cluster.name}" (id: ${cluster.id}, ${cluster.member_count} members):\n  - ${memberTexts}${linked ? `\n  Links: ${linked}` : ''}`
      );
    }

    const systemPrompt = `You are a memory cluster maintenance system. Analyze the clusters below and suggest reorganization actions. Return ONLY valid JSON with this exact structure:
{"actions":[]}

Action types:
- merge: {"type":"merge","sourceClusterId":"...","targetClusterId":"...","reason":"..."}
  Use when two clusters cover the same topic.
- move: {"type":"move","memberId":"...","fromClusterId":"...","toClusterId":"...","reason":"..."}
  Use when a specific fact belongs in a different cluster.
- split: {"type":"split","clusterId":"...","memberIds":["..."],"newClusterName":"...","reason":"..."}
  Use when a cluster contains clearly distinct subtopics.

Rules:
- Only suggest actions you are confident about.
- Prefer fewer, high-confidence actions over many speculative ones.
- If clusters look well-organized, return {"actions":[]}.
- Do NOT suggest merging clusters that cover genuinely different topics.`;

    const userPrompt = clusterSummaries.join('\n\n');

    const { content } = await callLLM(systemPrompt, userPrompt);
    const parsed = parseJSON(content);

    if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
      console.log('[Heartbeat] No cluster actions suggested');
      return results;
    }

    console.log(`[Heartbeat] LLM suggested ${parsed.actions.length} cluster actions`);

    const db = getSqliteDb();
    const clusterTable = await getClusterEmbeddingsTable();

    for (const action of parsed.actions) {
      try {
        if (action.type === 'merge' && action.sourceClusterId && action.targetClusterId) {
          // Verify both clusters exist
          const source = db.prepare('SELECT id FROM memory_clusters WHERE id = ?').get(action.sourceClusterId);
          const target = db.prepare('SELECT id FROM memory_clusters WHERE id = ?').get(action.targetClusterId);
          if (!source || !target) continue;

          console.log(`[Heartbeat] Merging cluster ${action.sourceClusterId} → ${action.targetClusterId}: ${action.reason}`);

          // Move all members
          const members = db.prepare('SELECT * FROM cluster_members WHERE cluster_id = ?').all(action.sourceClusterId);
          for (const member of members) {
            db.prepare('UPDATE cluster_members SET cluster_id = ? WHERE id = ?')
              .run(action.targetClusterId, member.id);

            // Re-embed in LanceDB
            if (clusterTable) {
              try {
                await clusterTable.delete(`member_id = "${member.id}"`);
                const embedding = await memoryClusters.generateEmbedding(member.content);
                if (embedding) {
                  await clusterTable.add([{
                    id: randomUUID(),
                    member_id: member.id,
                    cluster_id: action.targetClusterId,
                    content: member.content,
                    vector: Array.from(embedding)
                  }]);
                }
              } catch (e) {
                console.error('[Heartbeat] LanceDB re-embed error:', e.message);
              }
            }
          }

          // Delete empty source cluster and its links
          db.prepare('DELETE FROM cluster_links WHERE cluster_a = ? OR cluster_b = ?')
            .run(action.sourceClusterId, action.sourceClusterId);
          db.prepare('DELETE FROM memory_clusters WHERE id = ?')
            .run(action.sourceClusterId);

          db.prepare('UPDATE memory_clusters SET updated_at = ? WHERE id = ?')
            .run(new Date().toISOString(), action.targetClusterId);

          results.merges++;

        } else if (action.type === 'move' && action.memberId && action.fromClusterId && action.toClusterId) {
          // Verify member and clusters exist
          const member = db.prepare('SELECT * FROM cluster_members WHERE id = ? AND cluster_id = ?')
            .get(action.memberId, action.fromClusterId);
          const target = db.prepare('SELECT id FROM memory_clusters WHERE id = ?').get(action.toClusterId);
          if (!member || !target) continue;

          console.log(`[Heartbeat] Moving member ${action.memberId}: ${action.fromClusterId} → ${action.toClusterId}: ${action.reason}`);

          db.prepare('UPDATE cluster_members SET cluster_id = ? WHERE id = ?')
            .run(action.toClusterId, action.memberId);

          // Re-embed
          if (clusterTable) {
            try {
              await clusterTable.delete(`member_id = "${action.memberId}"`);
              const embedding = await memoryClusters.generateEmbedding(member.content);
              if (embedding) {
                await clusterTable.add([{
                  id: randomUUID(),
                  member_id: action.memberId,
                  cluster_id: action.toClusterId,
                  content: member.content,
                  vector: Array.from(embedding)
                }]);
              }
            } catch (e) {
              console.error('[Heartbeat] LanceDB re-embed error:', e.message);
            }
          }

          // Update cluster_links
          db.prepare('UPDATE memory_clusters SET updated_at = ? WHERE id = ?')
            .run(new Date().toISOString(), action.toClusterId);

          results.moves++;

        } else if (action.type === 'split' && action.clusterId && Array.isArray(action.memberIds) && action.newClusterName) {
          // Verify source cluster and members
          const sourceCluster = db.prepare('SELECT id FROM memory_clusters WHERE id = ?').get(action.clusterId);
          if (!sourceCluster) continue;

          const membersToMove = [];
          for (const mid of action.memberIds) {
            const m = db.prepare('SELECT * FROM cluster_members WHERE id = ? AND cluster_id = ?')
              .get(mid, action.clusterId);
            if (m) membersToMove.push(m);
          }
          if (membersToMove.length === 0) continue;

          console.log(`[Heartbeat] Splitting ${membersToMove.length} members from ${action.clusterId} into "${action.newClusterName}": ${action.reason}`);

          // Create new cluster
          const newClusterId = randomUUID();
          const now = new Date().toISOString();
          db.prepare('INSERT INTO memory_clusters (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(newClusterId, action.newClusterName, '', now, now);

          // Move members
          for (const member of membersToMove) {
            db.prepare('UPDATE cluster_members SET cluster_id = ? WHERE id = ?')
              .run(newClusterId, member.id);

            if (clusterTable) {
              try {
                await clusterTable.delete(`member_id = "${member.id}"`);
                const embedding = await memoryClusters.generateEmbedding(member.content);
                if (embedding) {
                  await clusterTable.add([{
                    id: randomUUID(),
                    member_id: member.id,
                    cluster_id: newClusterId,
                    content: member.content,
                    vector: Array.from(embedding)
                  }]);
                }
              } catch (e) {
                console.error('[Heartbeat] LanceDB re-embed error:', e.message);
              }
            }
          }

          results.splits++;
        }
      } catch (actionErr) {
        console.error(`[Heartbeat] Error executing ${action.type} action:`, actionErr.message);
      }
    }

    // Rename all clusters after reorganization
    if (results.merges > 0 || results.moves > 0 || results.splits > 0) {
      await memoryClusters.renameAllClusters();
    }

  } catch (error) {
    console.error('[Heartbeat] auditClusters error:', error.message);
  }

  console.log(`[Heartbeat] Cluster audit complete: ${results.merges} merges, ${results.moves} moves, ${results.splits} splits`);
  return results;
}

// ============ Task B: Cleanup Facts ============

async function cleanupFacts() {
  console.log('[Heartbeat] Task B: Cleaning up facts...');
  const results = { removed: 0, reworded: 0, merged: 0 };

  try {
    const memoryFile = path.join(MEMORY_DIR, 'MEMORY.md');
    if (!fs.existsSync(memoryFile)) {
      console.log('[Heartbeat] No MEMORY.md found');
      return results;
    }

    let content = fs.readFileSync(memoryFile, 'utf8');
    const facts = factExtractor.extractAllFactLines(content);

    if (facts.length < 3) {
      console.log('[Heartbeat] Too few facts to clean up');
      return results;
    }

    const systemPrompt = `You are a memory maintenance system. Review the facts below and suggest cleanup actions. Return ONLY valid JSON:
{"actions":[]}

Action types:
- remove: {"type":"remove","fact":"exact fact text","reason":"..."}
  Use for outdated, trivial, or clearly wrong facts.
- reword: {"type":"reword","original":"exact original text","replacement":"improved text","reason":"..."}
  Use for awkward phrasing, typos, or facts that could be clearer.
- merge: {"type":"merge","originals":["fact1","fact2"],"replacement":"merged fact","reason":"..."}
  Use when two or more facts say essentially the same thing.

Rules:
- Only suggest confident actions. When in doubt, leave facts alone.
- The "fact" and "original" fields must match the input EXACTLY (verbatim).
- Prefer merging duplicates over removing them.
- Do NOT remove facts just because they seem mundane — the user chose to remember them.
- If the facts look clean, return {"actions":[]}.`;

    const numberedFacts = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
    const { content: llmResponse } = await callLLM(systemPrompt, numberedFacts);
    const parsed = parseJSON(llmResponse);

    if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
      console.log('[Heartbeat] No fact cleanup actions suggested');
      return results;
    }

    console.log(`[Heartbeat] LLM suggested ${parsed.actions.length} fact cleanup actions`);

    const db = getSqliteDb();
    const clusterTable = await getClusterEmbeddingsTable();
    const lines = content.split('\n');

    // Process actions in reverse order of line position to preserve indices
    // Build a list of line operations first
    const lineOps = []; // { lineIndex, op: 'delete' | 'replace', newText? }

    for (const action of parsed.actions) {
      try {
        if (action.type === 'remove' && action.fact) {
          const lineIdx = lines.findIndex(l => l === `- ${action.fact}`);
          if (lineIdx >= 0) {
            lineOps.push({ lineIndex: lineIdx, op: 'delete' });
            console.log(`[Heartbeat] Removing fact: "${action.fact}" — ${action.reason}`);
            results.removed++;
          }

        } else if (action.type === 'reword' && action.original && action.replacement) {
          const lineIdx = lines.findIndex(l => l === `- ${action.original}`);
          if (lineIdx >= 0) {
            lineOps.push({ lineIndex: lineIdx, op: 'replace', newText: `- ${action.replacement}` });
            console.log(`[Heartbeat] Rewording: "${action.original}" → "${action.replacement}"`);
            results.reworded++;

            // Update cluster_members content + re-embed
            if (db) {
              const member = db.prepare('SELECT id, cluster_id FROM cluster_members WHERE content = ?')
                .get(action.original);
              if (member) {
                db.prepare('UPDATE cluster_members SET content = ? WHERE id = ?')
                  .run(action.replacement, member.id);
                if (clusterTable) {
                  try {
                    await clusterTable.delete(`member_id = "${member.id}"`);
                    const embedding = await memoryClusters.generateEmbedding(action.replacement);
                    if (embedding) {
                      await clusterTable.add([{
                        id: randomUUID(),
                        member_id: member.id,
                        cluster_id: member.cluster_id,
                        content: action.replacement,
                        vector: Array.from(embedding)
                      }]);
                    }
                  } catch (e) {
                    console.error('[Heartbeat] LanceDB re-embed error:', e.message);
                  }
                }
              }
            }
          }

        } else if (action.type === 'merge' && Array.isArray(action.originals) && action.replacement) {
          const lineIndices = [];
          for (const orig of action.originals) {
            const idx = lines.findIndex(l => l === `- ${orig}`);
            if (idx >= 0) lineIndices.push({ idx, text: orig });
          }
          if (lineIndices.length < 2) continue;

          // Replace first occurrence, delete the rest
          lineOps.push({ lineIndex: lineIndices[0].idx, op: 'replace', newText: `- ${action.replacement}` });
          for (let i = 1; i < lineIndices.length; i++) {
            lineOps.push({ lineIndex: lineIndices[i].idx, op: 'delete' });
          }

          console.log(`[Heartbeat] Merging ${lineIndices.length} facts into: "${action.replacement}"`);
          results.merged++;

          // Update first cluster member, delete others
          if (db) {
            let keptMember = null;
            for (const { text } of lineIndices) {
              const member = db.prepare('SELECT id, cluster_id FROM cluster_members WHERE content = ?').get(text);
              if (!member) continue;

              if (!keptMember) {
                keptMember = member;
                db.prepare('UPDATE cluster_members SET content = ? WHERE id = ?')
                  .run(action.replacement, member.id);
                if (clusterTable) {
                  try {
                    await clusterTable.delete(`member_id = "${member.id}"`);
                    const embedding = await memoryClusters.generateEmbedding(action.replacement);
                    if (embedding) {
                      await clusterTable.add([{
                        id: randomUUID(),
                        member_id: member.id,
                        cluster_id: member.cluster_id,
                        content: action.replacement,
                        vector: Array.from(embedding)
                      }]);
                    }
                  } catch (e) {
                    console.error('[Heartbeat] LanceDB re-embed error:', e.message);
                  }
                }
              } else {
                // Delete duplicate member
                db.prepare('DELETE FROM cluster_members WHERE id = ?').run(member.id);
                if (clusterTable) {
                  try {
                    await clusterTable.delete(`member_id = "${member.id}"`);
                  } catch (e) {
                    console.error('[Heartbeat] LanceDB delete error:', e.message);
                  }
                }
              }
            }
          }
        }
      } catch (actionErr) {
        console.error(`[Heartbeat] Error executing ${action.type} fact action:`, actionErr.message);
      }
    }

    // Apply line operations (sort by line index descending to preserve positions)
    lineOps.sort((a, b) => b.lineIndex - a.lineIndex);
    for (const op of lineOps) {
      if (op.op === 'delete') {
        lines.splice(op.lineIndex, 1);
      } else if (op.op === 'replace') {
        lines[op.lineIndex] = op.newText;
      }
    }

    // Write back
    fs.writeFileSync(memoryFile, lines.join('\n'), 'utf8');

  } catch (error) {
    console.error('[Heartbeat] cleanupFacts error:', error.message);
  }

  console.log(`[Heartbeat] Fact cleanup complete: ${results.removed} removed, ${results.reworded} reworded, ${results.merged} merged`);
  return results;
}

// ============ Task C: Summarize Daily Logs ============

async function summarizeDailyLogs() {
  console.log('[Heartbeat] Task C: Summarizing old daily logs...');
  const results = { archived: 0, factsExtracted: 0 };

  try {
    if (!fs.existsSync(DAILY_DIR)) {
      console.log('[Heartbeat] No daily log directory');
      return results;
    }

    const files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.md'));
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const oldFiles = files.filter(f => {
      const dateStr = f.replace('.md', '');
      const fileDate = new Date(dateStr);
      return !isNaN(fileDate.getTime()) && fileDate < sevenDaysAgo;
    });

    if (oldFiles.length === 0) {
      console.log('[Heartbeat] No daily logs older than 7 days');
      return results;
    }

    console.log(`[Heartbeat] Found ${oldFiles.length} daily logs to archive`);

    const memoryFile = path.join(MEMORY_DIR, 'MEMORY.md');

    for (const file of oldFiles) {
      try {
        const filePath = path.join(DAILY_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');

        if (content.trim().length < 20) {
          // Too short to summarize, just archive
          if (!fs.existsSync(ARCHIVE_DIR)) {
            fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
          }
          fs.renameSync(filePath, path.join(ARCHIVE_DIR, file));
          results.archived++;
          continue;
        }

        const systemPrompt = `You are a memory log summarizer. Review the daily log below and extract any important facts that should be preserved long-term. Return ONLY valid JSON:
{"summary":"one-line summary of the day","remainingFacts":["fact1","fact2"]}

Rules:
- remainingFacts should only contain facts worth preserving permanently (user preferences, project decisions, personal info).
- Write facts as "User has..." or "User prefers..." style.
- Skip routine entries like "Chat exchange with model - 0 facts extracted".
- If nothing is worth keeping, return {"summary":"...","remainingFacts":[]}.`;

        const { content: llmResponse } = await callLLM(systemPrompt, content);
        const parsed = parseJSON(llmResponse);

        if (parsed && Array.isArray(parsed.remainingFacts) && parsed.remainingFacts.length > 0) {
          const validFacts = parsed.remainingFacts.filter(f => typeof f === 'string' && f.trim().length > 0);
          if (validFacts.length > 0) {
            await factExtractor.appendToMemory(validFacts, memoryFile);
            results.factsExtracted += validFacts.length;
            console.log(`[Heartbeat] Extracted ${validFacts.length} facts from ${file}`);
          }
        }

        // Archive the file
        if (!fs.existsSync(ARCHIVE_DIR)) {
          fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        }
        fs.renameSync(filePath, path.join(ARCHIVE_DIR, file));
        results.archived++;
        console.log(`[Heartbeat] Archived ${file}`);

      } catch (fileErr) {
        console.error(`[Heartbeat] Error processing daily log ${file}:`, fileErr.message);
      }
    }

  } catch (error) {
    console.error('[Heartbeat] summarizeDailyLogs error:', error.message);
  }

  console.log(`[Heartbeat] Daily log archival complete: ${results.archived} archived, ${results.factsExtracted} facts extracted`);
  return results;
}

// ============ Task D: Maintain Links ============

async function maintainLinks() {
  console.log('[Heartbeat] Task D: Maintaining cluster links...');
  const results = { pruned: 0, strengthened: 0 };

  try {
    const db = getSqliteDb();
    if (!db) {
      console.log('[Heartbeat] Database not available');
      return results;
    }

    // Prune weak links
    const weakLinks = db.prepare('SELECT id FROM cluster_links WHERE strength < 0.3').all();
    if (weakLinks.length > 0) {
      db.prepare('DELETE FROM cluster_links WHERE strength < 0.3').run();
      results.pruned = weakLinks.length;
      console.log(`[Heartbeat] Pruned ${weakLinks.length} weak links`);
    }

    // Strengthen co-occurring clusters (members created on same day)
    const membersByDate = db.prepare(`
      SELECT cluster_id, DATE(created_at) as created_date
      FROM cluster_members
      GROUP BY cluster_id, DATE(created_at)
    `).all();

    // Group by date
    const dateGroups = {};
    for (const row of membersByDate) {
      if (!dateGroups[row.created_date]) dateGroups[row.created_date] = [];
      dateGroups[row.created_date].push(row.cluster_id);
    }

    // For each date with multiple clusters, strengthen links between them
    for (const [date, clusterIds] of Object.entries(dateGroups)) {
      const unique = [...new Set(clusterIds)];
      if (unique.length < 2) continue;

      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          const link = db.prepare(`
            SELECT id, strength FROM cluster_links
            WHERE (cluster_a = ? AND cluster_b = ?)
               OR (cluster_a = ? AND cluster_b = ?)
          `).get(unique[i], unique[j], unique[j], unique[i]);

          if (link) {
            const newStrength = Math.min(1.0, link.strength + 0.05);
            if (newStrength !== link.strength) {
              db.prepare('UPDATE cluster_links SET strength = ? WHERE id = ?')
                .run(newStrength, link.id);
              results.strengthened++;
            }
          }
        }
      }
    }

  } catch (error) {
    console.error('[Heartbeat] maintainLinks error:', error.message);
  }

  console.log(`[Heartbeat] Link maintenance complete: ${results.pruned} pruned, ${results.strengthened} strengthened`);
  return results;
}

// ============ Orchestration ============

/**
 * Run all maintenance tasks sequentially
 * @returns {Promise<Object>} Combined results from all tasks
 */
async function runMaintenance() {
  if (isRunning) {
    console.log('[Heartbeat] Maintenance already in progress, skipping');
    return { skipped: true };
  }

  isRunning = true;
  const startTime = Date.now();
  console.log('[Heartbeat] === Starting maintenance cycle ===');

  try {
    const audit = await auditClusters();
    const cleanup = await cleanupFacts();
    const archive = await summarizeDailyLogs();
    const links = await maintainLinks();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
    console.log(`[Heartbeat] === Maintenance complete in ${elapsed} ===`);

    return { audit, cleanup, archive, links, elapsed };
  } catch (error) {
    console.error('[Heartbeat] Maintenance cycle error:', error.message);
    return { error: error.message };
  } finally {
    isRunning = false;
  }
}

/**
 * Start the heartbeat timer
 * @param {number} intervalMs - Interval between runs (default: 2 hours)
 */
function startHeartbeat(intervalMs = 2 * 60 * 60 * 1000) {
  if (heartbeatTimer) {
    console.log('[Heartbeat] Already running, ignoring start');
    return;
  }

  const intervalHours = (intervalMs / (60 * 60 * 1000)).toFixed(1);
  console.log(`[Heartbeat] Scheduled every ${intervalHours}h (first run in 5min)`);

  // 5-minute warmup delay, then first run + interval
  setTimeout(() => {
    runMaintenance().catch(err => {
      console.error('[Heartbeat] Initial run error:', err.message);
    });

    heartbeatTimer = setInterval(() => {
      runMaintenance().catch(err => {
        console.error('[Heartbeat] Scheduled run error:', err.message);
      });
    }, intervalMs);
  }, 5 * 60 * 1000);
}

/**
 * Stop the heartbeat timer
 */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log('[Heartbeat] Stopped');
  }
}

module.exports = { runMaintenance, startHeartbeat, stopHeartbeat };
