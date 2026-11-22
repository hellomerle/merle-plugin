#!/usr/bin/env node
/**
 * The pause gate (docs/sessions.md, Pause): Claude Code's PreToolUse hook, before every tool of every session.
 *
 * While the session's own pause file is on this Mac (written only by the Merle runner, from a Pause the person who
 * paired the Mac pressed in Merle), it refuses the tool: `permissionDecision: "deny"`, so the tool never runs.
 * - The first refusal of a pause asks Claude to end its turn in one line. Its turn then ends as any turn does, so the
 *   session's Stop hooks run and its waiting hook is there to wake it with a note after Resume.
 * - Any later refusal of the same pause also says `continue: false`, which ends the turn whatever Claude wanted next.
 * Tried on Claude Code 2.1.325 (15 Nov 2026): `continue: false` alone still runs the tool and ends the turn after it,
 * and its turn ends without the Stop hooks; deny alone with that reason, Claude ended its turn after one refusal and
 * the Stop hooks ran. Not paused, it prints nothing and the tool goes on as it would have.
 *
 * Its only answer is deny: it never allows or asks, so it can't approve a tool call or change one. It looks at one
 * local file, asks nothing of Merle, the network or the Keychain, and loads nothing it doesn't need, so it adds no wait
 * to a tool call. A pause file it can't look at counts as paused. Each refused tool is a line in the runner's log here.
 *
 * Its paths are the runner's (merle-runner.mjs HOME and LOG); tests/install/pause.test.ts holds them equal.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME =
  process.env.MERLE_RUNNER_HOME ?? join(homedir(), 'Library', 'Application Support', 'Merle');
export const LOG =
  process.env.MERLE_RUNNER_LOG ?? join(homedir(), 'Library', 'Logs', 'Merle', 'runner.jsonl');
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Whether this session is paused here: its pause file is there. Only looked at, never opened, so nothing put in its
 * place can hold a tool call up. One that is there but can't be looked at counts as paused too.
 */
export function pausedHere(session, agent) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return false;
  try {
    statSync(join(HOME, 'sessions', agent ? `${session}.${agent}.paused` : `${session}.paused`));
    return true;
  } catch (err) {
    // Not there, or no sessions folder for it to be in: not paused. Anything else in the way: paused.
    return err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR';
  }
}

/**
 * Whether this is the pause's first refusal: true once, when its marker is made (O_EXCL, so only one call can). The
 * runner takes the marker away with each new pause and each resume. One it can't make counts as a later refusal.
 */
const firstRefusal = (session, agent) => {
  try {
    closeSync(
      openSync(join(HOME, 'sessions', agent ? `${session}.${agent}.held` : `${session}.held`), 'wx', 0o600),
    );
    return true;
  } catch {
    return false;
  }
};

/** Polite refusals a helper gets under the session's own pause, before its turn is ended for it. */
const HELPER_POLITE = 3;
/**
 * Under the session's own pause, a helper's refusal is polite (deny alone) its first few times, then ends its turn: a
 * helper that ignores "end your turn" can't keep the session making model calls (the security lens). Each counted
 * marker counts only for this pause: one older than the session's pause file is from a pause before, and is made again
 * (taken away, then made new, never following a link put in its place).
 */
const helperPolite = (session, agent) => {
  let since = 0;
  try {
    since = statSync(join(HOME, 'sessions', `${session}.paused`)).mtimeMs;
  } catch {}
  for (let k = 1; k <= HELPER_POLITE; k++) {
    const marker = join(HOME, 'sessions', `${session}.${agent}.${k}.held`);
    try {
      if (lstatSync(marker).mtimeMs >= since) continue;
    } catch {}
    try {
      rmSync(marker, { force: true });
      closeSync(openSync(marker, 'wx', 0o600));
      return true;
    } catch {
      return false; // one it can't make counts as spent: refusing harder is the safe way
    }
  }
  return false;
};

const WHY =
  'Paused from Merle by the person who paired this Mac. No tool runs until they press Resume in Merle.';
/** What Claude Code reads back at the first refusal: the tool refused, and end the turn now. */
export const FIRST = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `${WHY} Don’t try another tool: end your turn now in one line.`,
  },
};
/** At any later refusal: the tool refused and the turn over, whatever Claude wanted next. */
export const PAUSED = {
  continue: false,
  stopReason: 'Paused from Merle.',
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: WHY,
  },
};

function main() {
  let input = {};
  try {
    const v = JSON.parse(readFileSync(0, 'utf8'));
    if (v && typeof v === 'object') input = v;
  } catch {}
  const session = input.session_id;
  // Inside a teammate or a subagent (Claude Code's `agent_id`): its own pause file too, by its row key (event.mjs subOf),
  // so one teammate is held while the session's thread and the others go on. The session's pause holds
  // them all.
  const agent =
    typeof input.agent_id === 'string' && input.agent_id
      ? `sub-${createHash('sha256')
          .update(`${session}:${input.agent_id.slice(0, 200)}`)
          .digest('hex')
          .slice(0, 8)}`
      : null;
  const held = pausedHere(session) ? null : agent && pausedHere(session, agent) ? agent : undefined;
  if (held === undefined) return;
  // Each its own first refusal: the thread's marker is the session's, a teammate's its own, so a teammate held by the
  // session's pause never spends the thread's polite one (steer coverage 2.5). Under the session's pause a helper's are
  // counted for that pause (helperPolite).
  const first = !agent ? firstRefusal(session, null) : held === agent ? firstRefusal(session, agent) : false;
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    const tool = String(input.tool_name ?? '')
      .replace(/[^\w.:-]/g, '')
      .slice(0, 64);
    appendFileSync(
      LOG,
      `${JSON.stringify({ at: new Date().toISOString(), event: 'paused tool', session, ...(held ? { agent: held } : {}), tool, first })}\n`,
      { mode: 0o600 },
    );
  } catch {} // the pause holds even when its line can't be written: refusing is the safe way
  // Inside a teammate held by its own pause, a deny alone: `continue: false` there was never tried on Claude Code and
  // could end the session's own turn, which goes on while one teammate is held.
  // Under its own pause, a helper's refusal is always a deny alone; under the session's, a deny alone a few times first.
  const polite = first || (agent ? held === agent || helperPolite(session, agent) : false);
  process.stdout.write(`${JSON.stringify(polite ? FIRST : PAUSED)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
