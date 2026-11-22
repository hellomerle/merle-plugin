#!/usr/bin/env node
/**
 * After a tool (Claude Code's PostToolUse and PostToolUseFailure, every tool), when the person types (UserPromptSubmit),
 * or when Claude waits for them (the idle_prompt notification): if this session was waiting at the Mac on a permission
 * prompt (session-hook.mjs `waiting` left its marker), that prompt is over, so Merle stops showing it waiting. After a
 * tool, only the tool the prompt asked about counts: another one finishing alongside it doesn't.
 *
 * Runs after every tool, so it loads nothing unless the marker is there: one look at a file, then out. Only then does it
 * load the session hook and tell Merle, with a short timeout. After post_update it also tells Merle where an agent's ask
 * was made (askedHere). It prints nothing and decides nothing about any tool.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = process.env.MERLE_RUNNER_HOME ?? join(homedir(), 'Library', 'Application Support', 'Merle');
/**
 * This Mac's own folder only with hellomerle.com: a hook run for any other Merle (a test) with no folder of its own
 * writes nothing (the P0 of 22 Nov; merle-runner.mjs homeRefusal).
 */
const OFF =
  process.env.MERLE_RUNNER_HOME === undefined &&
  process.env.MERLE_URL !== undefined &&
  process.env.MERLE_URL !== 'https://app.hellomerle.com';
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

async function main() {
  let input = {};
  try {
    const v = JSON.parse(readFileSync(0, 'utf8'));
    if (v && typeof v === 'object') input = v;
  } catch {}
  const session = input.session_id;
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return;
  // After post_update, by any name it is installed under: tell Merle where the ask was made (session-hook.mjs askedHere),
  // beside ending a prompt, never before it, so a slow Merle can't hold the hook past its five seconds.
  const asked =
    input.hook_event_name === 'PostToolUse' &&
    /^mcp__[A-Za-z0-9_-]+__post_update$/.test(String(input.tool_name ?? ''))
      ? import('./session-hook.mjs').then((h) => h.askedHere(input)).catch(() => 0)
      : null;
  let marker = true;
  try {
    statSync(join(HOME, 'sessions', `${session}.waiting`));
  } catch {
    marker = false;
  }
  const afterTool = input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure';
  await Promise.all([
    asked,
    marker ? import('./session-hook.mjs').then((h) => h.answered(input, !afterTool)) : null,
  ]);
}

// A hook that fails says nothing: the session goes on, and its next check-in clears what Merle shows.
if (!OFF && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
