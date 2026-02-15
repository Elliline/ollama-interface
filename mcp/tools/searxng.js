/**
 * SearXNG Web Search Tool
 * Provides web search capability via a SearXNG instance
 */

class SearXNGTool {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.name = 'web_search';
    this.description = 'Search the web for current information using SearXNG. Use this when you need up-to-date information, current events, news, or facts you are unsure about.';
    this.parameters = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query'
        },
        num_results: {
          type: 'number',
          description: 'Number of results to return (default 5)'
        }
      },
      required: ['query']
    };
  }

  /**
   * Get the tool spec in OpenAI function calling format
   */
  getOpenAIFunctionSpec() {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters
      }
    };
  }

  /**
   * Execute the web search
   * @param {Object} args - { query: string, num_results?: number }
   * @param {string} endpointOverride - Optional endpoint override from user settings
   * @returns {Object} Search results or error
   */
  async execute(args, endpointOverride) {
    const endpoint = endpointOverride || this.endpoint;
    const { query } = args;
    const num_results = Math.min(Math.max(parseInt(args.num_results) || 5, 1), 20);

    if (!query || typeof query !== 'string') {
      return { error: 'Missing or invalid search query' };
    }

    try {
      const searchUrl = `${endpoint}/search?q=${encodeURIComponent(query)}&format=json`;
      const response = await fetch(searchUrl, {
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) {
        return { error: `Search failed with status ${response.status}` };
      }

      const data = await response.json();
      const results = (data.results || []).slice(0, num_results).map(r => ({
        title: r.title || '',
        url: r.url || '',
        snippet: (r.content || '').substring(0, 300)
      }));

      if (results.length === 0) {
        return { results: [], message: 'No results found for this query' };
      }

      return { results };
    } catch (error) {
      return { error: `Search failed: ${error.message}` };
    }
  }
}

module.exports = SearXNGTool;
