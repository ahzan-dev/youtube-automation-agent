#!/usr/bin/env node
// Lumen MCP server — lets an MCP client (Claude Code, Claude Desktop, …)
// operate a running Lumen / AgentTube instance over stdio.
//
// Configuration (environment):
//   LUMEN_URL          base URL of the instance, e.g. https://lumen.example.com or http://localhost:3456
//   LUMEN_API_KEY      the instance's API_KEY (needed for every mutating tool)
//   LUMEN_BASIC_AUTH   "user:password" if a reverse proxy adds HTTP basic auth (optional)
//   LUMEN_TIMEOUT_MS   default per-request timeout (optional, 120000)
//
// Usage: node mcp/server.mjs   (or `npx lumen-mcp` once installed)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LumenClient } from './lumen-client.mjs';
import { registerTools } from './tools.mjs';
import { registerYouTubeTools } from './youtube-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));

function config() {
  const baseUrl = process.env.LUMEN_URL || 'http://localhost:3456';
  const apiKey = process.env.LUMEN_API_KEY || '';
  const basicAuth = process.env.LUMEN_BASIC_AUTH || '';
  const timeoutMs = Number(process.env.LUMEN_TIMEOUT_MS || 120_000);
  return { baseUrl, apiKey, basicAuth, timeoutMs };
}

async function main() {
  const settings = config();
  const client = new LumenClient(settings);
  const server = new McpServer(
    { name: 'lumen', version: pkg.version },
    {
      instructions: [
        `Lumen (AgentTube) instance at ${settings.baseUrl}.`,
        'Lumen runs a YouTube channel end to end with an approval-first workflow: generation is autonomous, publishing is not.',
        'Start with get_status. Use list_productions(reviewStatus="needs_attention"|"needs_review") to find work, get_production for detail.',
        'Tools that spend provider credits or lead to a YouTube upload require confirm=true; tell the operator the cost or consequence first.',
        'Approval, provenance decisions, media-rights and factual-review flags are human attestations: record them only when the operator has explicitly made that decision.',
        'youtube_* tools act directly on the live YouTube channel (branding, videos, playlists, comments, captions, analytics); anything public-facing requires confirm=true.',
        settings.apiKey ? '' : 'WARNING: LUMEN_API_KEY is not set — mutating tools will fail with 401 unless the instance has no API_KEY configured.'
      ].filter(Boolean).join('\n')
    }
  );

  registerTools(server, client);
  registerYouTubeTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never log to stdout: it is the MCP transport.
  console.error(`[lumen-mcp ${pkg.version}] connected — target ${settings.baseUrl}${settings.basicAuth ? ' (basic auth)' : ''}${settings.apiKey ? '' : ' (no API key)'}`);
}

main().catch(error => {
  console.error('[lumen-mcp] fatal:', error);
  process.exit(1);
});
