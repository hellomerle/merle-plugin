#!/usr/bin/env node
/**
 * After a tool (Claude Code's PostToolUse and PostToolUseFailure, every tool), when the person types (UserPromptSubmit),
 * or when Claude waits for them (the idle_prompt notification): if this session was waiting at the Mac on a permission
 * prompt (session-hook.mjs `waiting` left its marker), that prompt is over, so Merle stops showing it waiting. After a
 * tool, only the tool the prompt asked about counts: another one finishing alongside it doesn't.
 *
 * Runs after every tool, so it loads nothing unless the marker is there: one look at a file, then out. Only then does it
 * load the session hook and tell Merle, with a short timeout. It prints nothing and decides nothing about any tool.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = process.env.MERLE_RUNNER_HOME ?? join(homedir(), 'Library', 'Application Support', 'Merle');
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

async function main() {
  let input = {};
  try {
    const v = JSON.parse(readFileSync(0, 'utf8'));
    if (v && typeof v === 'object') input = v;
  } catch {}
  const session = input.session_id;
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return;
  try {
    statSync(join(HOME, 'sessions', `${session}.waiting`));
  } catch {
    return;
  }
  const { answered } = await import('./session-hook.mjs');
  const afterTool = input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure';
  await answered(input, !afterTool);
}

// A hook that fails says nothing: the session goes on, and its next check-in clears what Merle shows.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
