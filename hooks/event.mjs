#!/usr/bin/env node
/**
 * One fact per hook event, appended to this Mac's spool (docs/sessions.md, Session events). The runner sends the spool
 * to Merle in batches; this never dials out, so it stays as fast as reading a file.
 *
 * Facts only, the same whatever coding agent sends them: which event, when, and counts or fixed words. Never what the
 * person typed (a prompt is its length), never a tool's input or output (a tool is its name, whether it worked and its
 * exit code), never a command (a commit, a push, a pull request or a test run is read from the command's first words
 * and named by a fixed word), never a path (a line with an agent's name keeps its hook's folder in the spool, for the
 * runner to check again, and the runner takes it off before sending). A subagent is its id and type, so each builder
 * is its own row in Merle. The one exception, only under session reading (docs/sessions.md): a helper's name, and the
 * one-line task its Agent call gave it (that call's `description`, never its `prompt`), on its own start line.
 *
 * Only for a session this Mac hooked up (session-hook.mjs left its record), and the spool never grows past SPOOL_MAX:
 * past it, events are left out until the runner has sent what's there.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../runner/reading.mjs';
import { scrubber } from '../runner/scrub.mjs';

const HOME = process.env.MERLE_RUNNER_HOME ?? join(homedir(), 'Library', 'Application Support', 'Merle');
/**
 * This Mac's own folder only with hellomerle.com: a hook run for any other Merle (a test) with no folder of its own
 * writes nothing (the P0 of 22 Nov; merle-runner.mjs homeRefusal).
 */
const OFF =
  process.env.MERLE_RUNNER_HOME === undefined &&
  process.env.MERLE_URL !== undefined &&
  process.env.MERLE_URL !== 'https://app.hellomerle.com';
export const SPOOL = join(HOME, 'spool');
export const SPOOL_FILE = join(SPOOL, 'events.jsonl');
/** A marker the runner watches: send now, not at the next look (waiting at the Mac, a session ending, a failure). */
export const SPOOL_NOW = join(SPOOL, 'now');
export const SPOOL_MAX = 1024 * 1024;
const SESSION = /^[A-Za-z0-9-]{8,64}$/;
/**
 * Fixed words only: a name a repo or an agent chooses (a custom subagent's, an MCP tool's, a model alias) could carry
 * words to Merle's agent, so each becomes one of these. Merle checks them against the same lists.
 */
export const TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'NotebookEdit',
  'ExitPlanMode',
  'AskUserQuestion',
  'Skill',
  'shell',
  'apply_patch',
];
export const AGENT_TYPES = ['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide'];
/** The other closed words a fact may carry: the runner and Merle check against the same (tests hold them equal). */
export const WORDS = {
  source: ['startup', 'resume', 'clear', 'compact', 'fork'],
  model: ['opus', 'sonnet', 'haiku', 'fable', 'other'],
  kind: ['permission', 'idle', 'input'],
  trigger: ['auto', 'manual'],
  reason: ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'],
};
const familyOf = (model) =>
  typeof model === 'string' && model
    ? (/(opus|sonnet|haiku|fable)/i.exec(model)?.[1]?.toLowerCase() ?? 'other')
    : null;
/** A subagent as Merle may know it: an opaque id made from its own (never its own), and a fixed type. */
export const subOf = (session, id) =>
  `sub-${createHash('sha256')
    .update(`${session}:${String(id).slice(0, 200)}`)
    .digest('hex')
    .slice(0, 8)}`;
const shortOf = (id) => id.replaceAll('-', '').slice(0, 8).toLowerCase();

/**
 * The command with each quoted string as one plain word, or null for shell it can't read safely (a quote left open, a
 * heredoc): words inside quotes are never a command (Codex).
 */
export function bareOf(command) {
  const bare = String(command ?? '')
    .slice(0, 4000)
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q');
  return /['"`]|<</.test(bare) ? null : bare;
}
/** A package manager's own work, never a test run however its arguments read ("pnpm add -D vitest"). */
const MANAGE =
  /^(?:add|i|install|ci|remove|rm|uninstall|un|update|up|upgrade|link|unlink|outdated|why|info|view|publish|dlx|create|init)$/;

/** The commit, push, pull request or test run a shell command is, from each part's first words; never the words. */
export function actsOf(command) {
  const acts = new Set();
  const bare = bareOf(command);
  if (bare === null) return [];
  for (const part of bare.split(/&&|\|\||;|\||\n/)) {
    const w = part.trim().split(/\s+/);
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift(); // FOO=bar before it
    if (w[0] === 'time' || w[0] === 'sudo' || w[0] === 'exec') w.shift();
    const cmd = (w[0] ?? '').split('/').pop();
    // A dry run or a help page does nothing (git push -n is a dry run; git commit -n isn't): Codex.
    if (w.some((x) => /^(?:--dry-run|--help|-h|--version)$/.test(x))) continue;
    if (cmd === 'git' && w.includes('push') && w.includes('-n')) continue;
    // git's own options before its subcommand ("git -C dir push"): skipped, with their values.
    let k = 1;
    while (cmd === 'git' && w[k]?.startsWith('-')) k += w[k] === '-C' || w[k] === '-c' ? 2 : 1;
    if (cmd === 'git' && (w[k] === 'commit' || w[k] === 'push')) acts.add(w[k]);
    else if (cmd === 'gh' && w[1] === 'pr' && w[2] === 'create') acts.add('pr');
    else if (/^(?:vitest|jest|pytest|playwright|merle-check|mocha|rspec|phpunit)$/.test(cmd))
      acts.add('test');
    else if (/^(?:pnpm|npm|yarn|bun|npx)$/.test(cmd)) {
      const args = w.slice(1, 4);
      const stop = args.findIndex((x) => MANAGE.test(x));
      if (
        (stop < 0 ? args : args.slice(0, stop)).some((x) =>
          // A script by its name or a namespaced one ("test:edge", "check:types"), never a word that only starts so.
          /^(?:test|check|vitest|jest|playwright|e2e)(?::[\w.-]+)?$/.test(x),
        )
      )
        acts.add('test');
    } else if (/^(?:cargo|go|make|mix|dotnet|swift)$/.test(cmd) && /^(?:test|check)$/.test(w[1] ?? ''))
      acts.add('test');
  }
  return [...acts];
}

const int = (n, max) => (Number.isSafeInteger(n) && n >= 0 && n <= max ? n : undefined);

/** The most a helper's name or task is, in characters (code points, so a pair is never split). */
export const LINE_MAX = 80;
/**
 * Words from the Mac as reading renders them, for a helper's row: quoted or indented code stays on the Mac (a backtick,
 * a ~~~ fence, a line indented four or a tab), settings are cut to their names, then the whole is scrubbed and folded to
 * one line before it is cut (so a cut never leaves part of an address the scrubber would have known), to LINE_MAX
 * characters, a cut-off last word dropped. Empty when nothing may go.
 */
export const oneLine = (said) => {
  // Anything longer stays on the Mac: never cut before it is scrubbed (the second pass).
  const raw = String(said);
  if (raw.length > 4000 || /`|~~~|^ {4}|\t/m.test(raw)) return '';
  const sc = scrubber();
  const all = sc
    .plain(sc.text(settings(raw)))
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...all];
  if (chars.length <= LINE_MAX) return all;
  const cut = chars.slice(0, LINE_MAX).join('');
  const space = cut.lastIndexOf(' ');
  return space > 0 ? cut.slice(0, space).trim() : cut;
};

/**
 * Claude Code's hook input as one fact, or null for an event it says nothing about. The first adapter: another agent's
 * hooks map their own events to the same facts. `o.task` is a helper's task, held for its start (taskFor): only on
 * that start's line, only with `o.names`.
 */
export function factOf(input, now = Date.now(), o = { names: false, task: '' }) {
  const session = input?.session_id;
  if (typeof session !== 'string' || !SESSION.test(session)) return null;
  const at = now;
  // Each line its own id, so a batch sent again is kept once.
  const base = { v: 1, id: randomBytes(6).toString('hex'), client: 'claude-code', session, at };
  const agentId =
    typeof input.agent_id === 'string' && input.agent_id.length > 0 ? input.agent_id.slice(0, 200) : null;
  const agentType = AGENT_TYPES.includes(input.agent_type) ? input.agent_type : 'custom';
  const agent = agentId ? { agent: { id: subOf(session, agentId), type: agentType } } : {};
  // Its own name, for its row: only while this Mac reads its sessions (`o.names`: reading on with Touch ID, its folder
  // read), since it is words the lead wrote into its Agent call; scrubbed as reading's words are, 80 at most; on its
  // start and its going idle only (the founder, 21 Nov; CLAUDE.md non-negotiable 3).
  const said = o.names
    ? [input.agent_type, input.teammate_name].find((x) => typeof x === 'string' && x.trim())
    : null;
  const name = said ? oneLine(said) : '';
  const named = agentId ? { agent: { ...agent.agent, ...(name ? { name } : {}) } } : {};
  const toolName = String(input.tool_name ?? '');
  const tool = toolName.startsWith('mcp__') ? 'mcp' : TOOLS.includes(toolName) ? toolName : 'other';
  // Its one-line task, on its start only: what its Agent call said it was for (the founder, 23 Nov).
  const task = o.names && o.task ? oneLine(o.task) : '';
  switch (input.hook_event_name) {
    case 'SessionStart':
      return {
        ...base,
        e: 'start',
        ...(WORDS.source.includes(input.source) ? { source: input.source } : {}),
        ...(familyOf(input.model) ? { model: familyOf(input.model) } : {}),
      };
    case 'UserPromptSubmit':
      return {
        ...base,
        ...agent,
        e: 'prompt',
        len: typeof input.prompt === 'string' ? Math.min(input.prompt.length, 1e7) : 0,
      };
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const ok = input.hook_event_name === 'PostToolUse';
      // Only the first line of the error, only its number: "Exit code 1".
      const code = ok
        ? 0
        : Number(/^Exit code (\d{1,3})\b/.exec(String(input.error ?? ''))?.[1] ?? Number.NaN);
      // A shell's exit code is 0 to 255; anything else is no code at all, as Merle takes it.
      const acts = tool === 'Bash' ? actsOf(input.tool_input?.command) : [];
      // Sent to the background, it has only started: no exit code and no outcome yet (Codex).
      const bg =
        tool === 'Bash' &&
        (input.tool_input?.run_in_background === true || input.tool_response?.backgroundTaskId != null);
      // Joined by anything but && ("pnpm test || true", "a; b", "a | b"), the exit code is the last part's alone; a
      // failed && chain doesn't say which part failed ("cd missing && pnpm test"): whether a test passed or a pull
      // request was made isn't known (Codex).
      const bare = bareOf(input.tool_input?.command) ?? '';
      const mixed =
        acts.length > 0 &&
        (bg ||
          // The shell's own `&` (never `&&`, `2>&1` or `&>`): sent to the background, it has only started (Codex).
          /(?:^|[^&>])&(?![&>])/.test(bare) ||
          /\|\||;|\||\n/.test(bare.replace(/&&/g, '')) ||
          (!ok && bare.includes('&&')));
      const ms = int(Math.round(Number(input.duration_ms ?? input.tool_response?.duration_ms)), 86_400_000);
      return {
        ...base,
        ...agent,
        e: 'tool',
        tool,
        ok,
        ...(input.is_interrupt === true ? { stopped: true } : {}),
        ...(tool === 'Bash' && !bg && Number.isSafeInteger(code) && code <= 255 ? { exit: code } : {}),
        ...(acts.length ? { acts } : {}),
        ...(mixed ? { mixed: true } : {}),
        ...(ms !== undefined ? { ms } : {}),
      };
    }
    case 'Notification': {
      const kind = { permission_prompt: 'permission', idle_prompt: 'idle', agent_needs_input: 'input' }[
        input.notification_type
      ];
      return kind ? { ...base, ...agent, e: 'wait', kind } : null;
    }
    case 'Stop':
      return { ...base, ...agent, e: 'stop' };
    case 'SubagentStart':
      return agentId
        ? { ...base, agent: { ...named.agent, ...(task ? { task } : {}) }, e: 'sub_start' }
        : null;
    case 'SubagentStop':
      return agentId ? { ...base, ...agent, e: 'sub_stop' } : null;
    // An in-process teammate's turn ends with TeammateIdle (SubagentStart opens each one): its own stop, by its own id.
    case 'TeammateIdle':
      return agentId ? { ...base, ...named, e: 'stop' } : null;
    case 'PreCompact':
      return {
        ...base,
        e: 'compact',
        ...(WORDS.trigger.includes(input.trigger) ? { trigger: input.trigger } : {}),
      };
    case 'SessionEnd':
      return {
        ...base,
        e: 'end',
        ...(WORDS.reason.includes(input.reason) ? { reason: input.reason } : {}),
      };
    default:
      return null;
  }
}

/** Whether this Mac hooked the session up and it wasn't unhooked here (session-hook.mjs's record). */
const hooked = (session) => {
  try {
    const v = JSON.parse(readFileSync(join(HOME, 'sessions', `${shortOf(session)}.json`), 'utf8'));
    return !!v && typeof v === 'object' && v.session === session && v.unhooked !== true;
  } catch {
    return false;
  }
};

/**
 * Adds one fact to the spool, if there's room; a fact that should reach Merle now leaves the marker too. Only for a
 * session this Mac hooked up, in a folder it still allows (`merle-runner deny` stops it at once).
 */
export async function spool(fact, cwd) {
  if (!fact || !hooked(fact.session)) return false;
  const { allowed } = await import('./session-hook.mjs');
  if (typeof cwd !== 'string' || !allowed(cwd)) return false;
  mkdirSync(SPOOL, { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = statSync(SPOOL_FILE).size;
  } catch {}
  // A named line keeps the folder its hook ran in, for the runner to check again when it sends; never sent.
  const line = `${JSON.stringify(fact.agent?.name || fact.agent?.task ? { ...fact, here: cwd } : fact)}\n`;
  if (size + line.length > SPOOL_MAX) return false;
  appendFileSync(SPOOL_FILE, line, { mode: 0o600 });
  if (fact.e === 'wait' || fact.e === 'end' || (fact.e === 'tool' && !fact.ok && fact.acts?.includes('test')))
    appendFileSync(SPOOL_NOW, '', { mode: 0o600 });
  return true;
}

/**
 * What reading.jsonl keeps of an agent's name that left (docs/sessions.md, Session reading): that one did, its
 * session's short id, its hash and its length, never the words, so the person can see words left the Mac.
 */
export function nameLog(fact, log) {
  for (const [event, words] of [
    ['agent_name', fact?.agent?.name],
    ['agent_task', fact?.agent?.task],
  ])
    if (typeof words === 'string' && words)
      log({
        event,
        session: shortOf(fact.session),
        sha256: createHash('sha256').update(words).digest('hex'),
        chars: words.length,
      });
}

/**
 * The Agent calls a session made whose helper hasn't started yet, on this Mac only (`pending/<short id>.json`, its
 * owner's alone): each call's id, when, and its one-line task only while reading may send it. Read and written under a
 * lock made with O_EXCL (`.lock`), so two calls at once never lose one; a hook that can't take the lock leaves a mark
 * (`.unsure`) instead, and no start takes a task while it's fresh. A helper's start takes the task only from the one
 * call made in the PAIR_MS before it: none when two fell inside that window (which is whose can't be told), and none
 * from a call held longer (one refused before it ran never meets a helper resumed or forked later). A call goes when a
 * helper takes it, when it failed, or once older than the window. All of it goes when reading goes off, or the session
 * is unhooked here.
 */
const PENDING = join(HOME, 'pending');
export const PAIR_MS = 10_000;
const pendingFile = (session, ext = 'json') => join(PENDING, `${shortOf(session)}.${ext}`);
const pendingOf = (session, now) => {
  try {
    const v = JSON.parse(readFileSync(pendingFile(session), 'utf8'));
    return v?.session === session && Array.isArray(v.calls)
      ? v.calls.filter(
          (c) =>
            typeof c?.id === 'string' &&
            Number.isSafeInteger(c.at) &&
            c.at <= now + 1000 &&
            now - c.at <= PAIR_MS,
        )
      : [];
  } catch {
    return [];
  }
};
/** `change` on this session's held calls, under the lock; false when the lock couldn't be taken (and the mark is left). */
/**
 * Takes this session's lock: a file made with O_EXCL holding a token of this process's own, so only its holder removes
 * it. One older than five seconds was left by a hook that died: it is moved aside under a name of the taker's own, and
 * taken over only if what moved is still that stale lock (another taker's fresh one is put back). Null when it can't.
 */
const takeLock = (lock) => {
  const token = randomBytes(8).toString('hex');
  for (const t = Date.now(); Date.now() - t < 500; ) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, token);
      closeSync(fd);
      return token;
    } catch {}
    try {
      const st = statSync(lock);
      if (Date.now() - st.mtimeMs > 5_000) {
        const was = readFileSync(lock, 'utf8');
        const aside = `${lock}.${token}`;
        renameSync(lock, aside);
        // What moved is a fresh lock another hook took meanwhile: back where it was, if the place is still free.
        if (readFileSync(aside, 'utf8') !== was)
          try {
            linkSync(aside, lock);
          } catch {}
        rmSync(aside, { force: true });
        continue;
      }
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // honesty: waits for the lock; moves no stage
  }
  return null;
};
/** Gives the lock back, only while it still holds this taker's token. */
const dropLock = (lock, token) => {
  try {
    if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true });
  } catch {}
};
/** `change` on this session's held calls, under the lock; false when the lock couldn't be taken (and the mark is left). */
const withPending = (session, now, change) => {
  mkdirSync(PENDING, { recursive: true, mode: 0o700 });
  const lock = pendingFile(session, 'lock');
  const token = takeLock(lock);
  if (!token) {
    writeFileSync(pendingFile(session, 'unsure'), String(now), { mode: 0o600 });
    return false;
  }
  try {
    const out = change(pendingOf(session, now));
    writeFileSync(pendingFile(session), JSON.stringify({ session, calls: out.calls.slice(-20) }), {
      mode: 0o600,
    });
    return 'value' in out ? out.value : true;
  } finally {
    dropLock(lock, token);
  }
};
/** A hook couldn't take the lock lately: no start takes a task for PAIR_MS. */
const unsure = (session, now) => {
  try {
    return now - Number(readFileSync(pendingFile(session, 'unsure'), 'utf8')) <= PAIR_MS;
  } catch {
    return false;
  }
};
const isAgentCall = (input) => input?.tool_name === 'Agent' || input?.tool_name === 'Task';
/**
 * Holds an Agent call until its helper starts (PreToolUse), or lets it go when the call failed (PostToolUseFailure: no
 * helper came of it). Never on its success: a background helper's call answers as it starts, its start's own hook may
 * still be reading. `task` is its cleaned line, empty when reading may not send it: the call is held either way, so
 * the count of calls in the window stays true.
 */
export function holdCall(input, now, task = '') {
  const session = input?.session_id;
  if (typeof session !== 'string' || !SESSION.test(session) || !isAgentCall(input) || !hooked(session))
    return;
  const id = String(input.tool_use_id ?? '').slice(0, 200);
  if (!id) return;
  withPending(session, now, (calls) => ({
    calls: [
      ...calls.filter((c) => c.id !== id),
      ...(input.hook_event_name === 'PreToolUse' ? [{ id, at: now, ...(task ? { task } : {}) }] : []),
    ],
  }));
}
/**
 * The task for a helper starting now, with when it was held: the one Agent call made in the window before it, taken;
 * none when another fell inside it, when a hook couldn't take the lock lately, or when the session isn't hooked here.
 */
export function taskFor(session, now) {
  if (typeof session !== 'string' || !SESSION.test(session) || !hooked(session)) return null;
  const got = withPending(session, now, (calls) => {
    // Under the lock, so a hook that missed it while this one waited has left its mark by now.
    if (unsure(session, now)) return { calls, value: null };
    const near = calls.filter((c) => c.at <= now);
    if (near.length !== 1) return { calls, value: null };
    const [one] = near;
    return { calls: calls.filter((c) => c !== one), value: one };
  });
  return got && typeof got === 'object' && typeof got.task === 'string'
    ? { task: got.task, at: got.at }
    : null;
}

/**
 * The fact for a hook's input, with its agent's name (and, on its start, its task) only while this Mac reads its
 * sessions (`r`, the runner) and only once its line in reading.jsonl is written: a log it can't write, and no words go
 * (as reading does). A task only under a reading-on signed with the words that name tasks (`readingTasks`).
 */
export function namedFact(input, now, r) {
  // A runner that can't say (it refuses this folder, its Keychain won't read): off, and the call is still held.
  const asks = (f) => {
    try {
      return f() === true;
    } catch {
      return false;
    }
  };
  const names = !!r && asks(() => r.readingOn() && !r.readingLeftOut(input?.cwd));
  const tasks = names && asks(() => r.readingTasks());
  const event = input?.hook_event_name;
  // Nothing is held while this Mac doesn't read: a failed call only lets go of one held while it did.
  if (isAgentCall(input) && ((names && event === 'PreToolUse') || event === 'PostToolUseFailure'))
    try {
      const said = input.tool_input?.description;
      if (event === 'PreToolUse' || existsSync(pendingFile(input.session_id)))
        holdCall(
          input,
          now,
          tasks && event === 'PreToolUse' && typeof said === 'string' ? oneLine(said) : '',
        );
    } catch {}
  let held = null;
  if (names && event === 'SubagentStart')
    try {
      held = taskFor(input.session_id, now);
    } catch {}
  // Only a task held since reading last went on here: one captured before an off and on again never goes.
  let since = null;
  if (held && tasks)
    try {
      since = r.readingSince();
    } catch {}
  const task = held && tasks && Number.isSafeInteger(since) && held.at >= since ? held.task : '';
  const fact = factOf(input, now, { names, task });
  if (fact?.agent?.name || fact?.agent?.task)
    try {
      nameLog(fact, r.readingLog);
    } catch {
      delete fact.agent.name;
      delete fact.agent.task;
    }
  return fact;
}

if (!OFF && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    // An agent's name goes only with its start and its going idle, its task only with its start, and only while this
    // Mac reads its sessions; an Agent call is held (PreToolUse) until its helper starts.
    const r =
      input?.hook_event_name === 'SubagentStart' ||
      input?.hook_event_name === 'TeammateIdle' ||
      (input?.hook_event_name === 'PreToolUse' && isAgentCall(input))
        ? await import('../runner/merle-runner.mjs').catch(() => null)
        : null;
    const fact = namedFact(input, Date.now(), r);
    await spool(fact, input?.cwd);
  } catch {}
  process.exit(0);
}
