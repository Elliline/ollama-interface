#!/usr/bin/env node
/**
 * Rebuild memory clusters from existing MEMORY.md facts.
 * Wipes cluster tables and LanceDB cluster_embeddings, then re-assigns each fact.
 */

const path = require('path');
const fs = require('fs');

// Initialize database first
const db = require('../db/database');
db.initDatabase();

async function main() {
  await db.initVectorStore();

  const sqliteDb = db.getSqliteDb();
  if (!sqliteDb) {
    console.error('SQLite database not available');
    process.exit(1);
  }

  // 1. Wipe cluster tables
  console.log('=== Wiping cluster tables ===');
  sqliteDb.exec('DELETE FROM cluster_links');
  sqliteDb.exec('DELETE FROM cluster_members');
  sqliteDb.exec('DELETE FROM memory_clusters');
  console.log('SQLite cluster tables cleared');

  // 2. Drop and recreate LanceDB cluster_embeddings for a clean index
  await db.resetClusterEmbeddingsTable();
  console.log('LanceDB cluster_embeddings reset');

  // 3. Read MEMORY.md and extract facts
  const memoryFile = path.join(__dirname, '../data/memory/MEMORY.md');
  const content = fs.readFileSync(memoryFile, 'utf8');
  const factLines = content.split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.substring(2).trim())
    .filter(f => f.length > 0);

  console.log(`\n=== Found ${factLines.length} facts in MEMORY.md ===`);
  factLines.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

  // 4. Assign each fact to clusters using the updated logic
  const memoryClusters = require('../db/memory-clusters');

  console.log('\n=== Assigning facts to clusters ===');
  for (let i = 0; i < factLines.length; i++) {
    const fact = factLines[i];
    console.log(`\n--- Fact ${i + 1}/${factLines.length}: "${fact.substring(0, 60)}..." ---`);
    const result = await memoryClusters.assignToCluster(fact, 'ollama', 'llama3.2', '', 'http://localhost:11434', 'memory-rebuild');
    console.log(`  → Cluster: ${result.clusterName} (new: ${result.isNew})`);
  }

  // 5. Print summary
  console.log('\n=== Cluster Summary ===');
  const clusters = memoryClusters.getClusters();
  for (const cluster of clusters) {
    console.log(`  ${cluster.name}: ${cluster.member_count} members`);
  }

  const linkCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM cluster_links').get();
  console.log(`\nTotal clusters: ${clusters.length}`);
  console.log(`Total cross-cluster links: ${linkCount.count}`);

  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Rebuild failed:', err);
  process.exit(1);
});
