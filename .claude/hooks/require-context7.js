#!/usr/bin/env node
// PreToolUse hook: block writes/edits to code files until a context7 docs
// lookup has happened since the user's most recent prompt.
//
// Reads the hook payload from stdin, scans the session transcript backwards
// to the last real user prompt, and denies the tool call if no context7 tool
// (any tool whose name contains "context7") was used in between.
// Fails open: any unexpected error allows the call so the hook never bricks a session.

const fs = require('fs');
const path = require('path');

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css']);

function allow() {
  process.exit(0);
}

function deny(reason) {
  // Synchronous write: process.stdout.write to a pipe is async on Windows and
  // process.exit() would truncate it.
  fs.writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function isRealUserPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary) return false;
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) return !content.some((c) => c && c.type === 'tool_result');
  return false;
}

function usedContext7(entry) {
  if (entry.type !== 'assistant') return false;
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return false;
  return content.some((c) => c && c.type === 'tool_use' && /context7/i.test(c.name || ''));
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || toolInput.notebook_path || '';

  // Only gate source code — docs, config, memory and .claude files pass through.
  const normalized = filePath.replace(/\\/g, '/');
  if (!CODE_EXT.has(path.extname(normalized).toLowerCase())) allow();
  if (/\/\.claude\//.test(normalized) || /\/node_modules\//.test(normalized)) allow();

  const transcriptPath = input.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) allow();

  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (usedContext7(entry)) allow();
    if (isRealUserPrompt(entry)) break;
  }

  deny(
    `Context7 check required before writing code (${path.basename(normalized)}). ` +
    'Before implementing, look up current docs for the libraries/APIs this change touches ' +
    'using the context7 MCP tools (resolve-library-id, then get-library-docs / query-docs), ' +
    'then retry this edit. If the context7 tools are not available in this session, tell the user ' +
    'so they can add the context7 MCP server (claude mcp add context7 -- npx -y @upstash/context7-mcp) ' +
    'or disable this hook via /hooks.'
  );
} catch (err) {
  allow();
}
