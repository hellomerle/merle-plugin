#!/usr/bin/env node
// `/merle connect`: adds Merle's MCP server for this folder, using MERLE_TOKEN from the environment. The token stays in
// this process, so it never appears in a command or a chat. It prints one word: connected, added or needs-token.
import { execFileSync } from 'node:child_process';

const MCP = 'https://app.hellomerle.com/mcp';
// Nothing is shown from `claude`, because `claude mcp get` prints the token.
const claude = (...args) => execFileSync('claude', args, { stdio: 'ignore' });

try {
  // "Connected" means Merle's own server, not any server a repo's .mcp.json happens to call merle: the entry is read
  // (never shown) and must name Merle's address.
  const got = execFileSync('claude', ['mcp', 'get', 'merle'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (got.includes(MCP)) {
    console.log('connected');
    process.exit(0);
  }
} catch {}

const token = process.env.MERLE_TOKEN;
if (!token) {
  console.log('needs-token');
  process.exit(0);
}
try {
  const header = `Authorization: Bearer ${token}`;
  claude('mcp', 'add', '--transport', 'http', '--scope', 'local', 'merle', MCP, '--header', header);
  console.log('added');
} catch {
  console.error('claude mcp add failed.');
  process.exit(1);
}
