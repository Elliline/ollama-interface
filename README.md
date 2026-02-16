# Squatch Neuro Hub

Neural-linked AI assistant with associative cluster memory, multi-provider support, and MCP tool calling. Part of the **Coastal Squatch AI** ecosystem by MettaSphere LLC.

## What Is Neuro Hub?

Neuro Hub is a self-hosted AI chat interface that remembers. Unlike stateless chatbots, it builds a persistent memory layer across conversations using a two-tier system: long-term facts stored in markdown files and associative memory clusters powered by vector embeddings. When you chat, relevant memories surface automatically through hybrid search (vector similarity + BM25 keyword matching), giving the AI genuine context about you, your projects, and your preferences.

## Features

- **Multi-Provider Support**: Ollama, Claude, OpenAI, Grok, SquatchServe, Llama.cpp
- **Associative Cluster Memory**: Facts are automatically clustered by topic with cross-cluster linking
- **Hybrid Search**: Combined vector (LanceDB) + BM25 (SQLite FTS5) retrieval
- **Two-Layer Memory**: Long-term facts (MEMORY.md) + daily session logs
- **Fact Extraction**: Automatic extraction of user facts after each exchange
- **Memory Panel**: Browse, search, edit, and delete memories from the UI
- **MCP Tool Calling**: Extensible tool system (SearXNG web search built in)
- **Voice Chat**: TTS (Kokoro) and STT (Whisper) integration
- **Streaming**: Real-time streaming responses from all providers
- **Context Flush**: Automatic context compaction before overflow

## Quick Start

```bash
npm install
cp .env.example .env   # Configure API keys and hosts
npm start              # http://localhost:3000
```

## Architecture

```
server.js                  Express backend, provider routing, memory injection
db/database.js             SQLite (chat + FTS5) + LanceDB (vectors)
db/fact-extractor.js       Extracts user facts, deduplicates, writes to memory files
db/memory-clusters.js      Associative clustering with curated naming
db/memory-flush.js         Context compaction before overflow
mcp/mcp-client.js          MCP tool calling framework
mcp/tools/searxng.js       SearXNG web search tool
routes/conversations.js    Conversation CRUD API
routes/memory.js           Memory management API
public/                    Vanilla JS frontend
data/memory/               MEMORY.md, USER.md, daily logs
data/chat.db               SQLite database
data/lancedb/              Vector embeddings
```

## Memory System

1. **Fact Extraction** -- After each chat exchange, facts about the user are extracted and deduplicated against existing memory using embedding similarity (>0.85 threshold).

2. **Cluster Assignment** -- New facts are assigned to associative clusters via vector search. Clusters are named using a curated keyword map with word-frequency fallback.

3. **Hybrid Retrieval** -- On each message, relevant past context is retrieved using `0.6 * vectorScore + 0.4 * bm25Score` fusion, plus cluster-aware associative recall.

4. **System Prompt Injection** -- Memory files, search results, and cluster context are injected into the system prompt for every provider.

## Providers

| Provider | Type | Tool Calling | Streaming |
|----------|------|:------------:|:---------:|
| Ollama | Local | Yes | NDJSON |
| Llama.cpp | Local | Yes | SSE |
| SquatchServe | Local | No | NDJSON |
| Claude | API | No | SSE |
| OpenAI | API | No | SSE |
| Grok | API | No | SSE |

## PM2

```bash
pm2 start server.js --name squatch-neuro-hub
pm2 save
```

## License

MIT
