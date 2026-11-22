#!/usr/bin/env node
/**
 * Session hookup (docs/sessions.md): notes from Merle reach this Claude Code, Codex or Cursor session, and only this one.
 *
 *   start [codex|cursor]      SessionStart: checks in, and tells the agent its id in Merle.
 *   next-note [codex|cursor]  Stop: at the end of a turn, "anything for this session?". A note comes back in the
 *              client's own shape and the agent carries on with it: Claude Code's additionalContext, Codex's
 *              decision "block" with the note as its reason, Cursor's followup_message (docs/more-agents.md).
 *   wait       Claude Code only, Stop with asyncRewake: waits in the background while the session is idle. A note is
 *              written to stderr and the hook exits 2, which wakes the session. Codex and Cursor have no such hook.
 *   waiting    Claude Code's Notification hook on a permission prompt: tells Merle the session waits at the Mac, with
 *              the tool's name and nothing else. after-tool.mjs says when it moved on (`answered`).
 *   unhook <id>      /merle unhook: notes stop reaching this session.
 *   signing on|off   Whether this Mac takes only notes signed with the passkey it pinned.
 *
 * Every call dials out to Merle with the paired Mac's token from the Keychain (merle-runner.mjs); nothing listens. A Mac
 * that isn't paired, or a folder that `merle-runner allow` didn't allow, does nothing and says nothing. A note for
 * another session or another Mac, out of date, or not signed when it must be, is refused and logged. Each note, taken or
 * refused, is a line in ~/Library/Logs/Merle/notes.jsonl, and a Mac that can't write that line takes none.
 *
 * Nothing here answers a permission prompt: the only output is words for Claude, labelled as the founder's.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  canonical,
  config,
  HOME,
  HOOK_SETTINGS,
  hookSettings,
  keep,
  kept,
  nonceStore,
  passkeySays,
  pausedRev,
  LOG as RUNNER_LOG,
  repoFor,
  signedBy,
  signingRequired,
} from '../runner/merle-runner.mjs';

const NOTES_LOG = process.env.MERLE_NOTES_LOG ?? join(dirname(RUNNER_LOG), 'notes.jsonl');
/** This plugin's own version, from the plugin.json beside these hooks: Merle shows "Update Merle on that Mac" by it. */
const PLUGIN_VERSION = (() => {
  try {
    const v = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    ).version;
    return typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
})();
/**
 * Every file the hooks run, by its path in the plugin, in order: each .mjs and .json in the hooks folder, and every file
 * they import by a relative path (the runner, reading, the scrubber, a skill), followed to the end.
 */
export function hooksFilesOf(dir) {
  const root = resolve(dir, '..');
  const seen = new Set();
  const next = readdirSync(dir)
    .filter((n) => /\.(?:mjs|json)$/.test(n))
    .map((n) => join(dir, n));
  while (next.length) {
    const f = resolve(next.pop());
    if (seen.has(f)) continue;
    seen.add(f);
    if (!f.endsWith('.mjs')) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/g,
    ))
      if (m[1]) next.push(resolve(dirname(f), m[1]));
  }
  return [...seen]
    .map((f) => {
      const rel = relative(root, f);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('a hook runs a file outside the plugin');
      return rel;
    })
    .sort();
}
/**
 * Everything the hooks run, as one hash: the first 16 hex of a SHA-256 over each of those files by its path in the
 * plugin. Merle asks for an update only when it differs from the one it published, never just because the plugin's
 * version moved. deploy.sh works out the published one with this same function.
 */
export function hooksShaOf(dir) {
  const root = resolve(dir, '..');
  const h = createHash('sha256');
  for (const f of hooksFilesOf(dir))
    h.update(`${f}\0`)
      .update(readFileSync(join(root, f)))
      .update('\0');
  return h.digest('hex').slice(0, 16);
}
const HOOKS_SHA = (() => {
  try {
    return hooksShaOf(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return undefined;
  }
})();
const SETTINGS = HOOK_SETTINGS;
const SESSIONS = join(HOME, 'sessions');
/** Signed notes' nonces: a store of their own, apart from the runner's jobs, each taken once under its lock. */
export const noteNonces = nonceStore(join(HOME, 'notes-nonces.json'));
/** Everything a note holds, and nothing else: a key Merle adds is refused, never ignored. */
const NOTE_KEYS = new Set([
  'v',
  'type',
  'id',
  'runner',
  'session',
  'kind',
  'from',
  'paired',
  'text',
  'refs',
  'agent',
  'created',
  'expires',
  'nonce',
]);
/** A teammate's row key (event.mjs subOf): a note naming one goes to that teammate's own hooks and no other. */
const AGENT_KEY = /^sub-[0-9a-f]{8}$/;
/** Seconds Merle holds one look open; the waiting hook looks again at once after. */
const WAIT = Math.max(1, Math.min(25, Number(process.env.MERLE_HOOK_WAIT) || 25));
/** A note waits a day for a sleeping Mac (sessions.ts NOTE_MS), plus a few minutes for clocks apart. */
const NOTE_MS = 24 * 3_600_000;
const MARGIN_MS = 5 * 60_000;
const NOTE_ID = /^n-[a-z]{8}$/;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

const shortOf = (id) => id.replaceAll('-', '').slice(0, 8).toLowerCase();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // honesty: waits between polls of Merle; only Merle moves a stage

const readInput = () => {
  try {
    const v = JSON.parse(readFileSync(0, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
/** The coding agents besides Claude Code whose hooks run this script (merle-runner hooks codex|cursor). */
const OTHER_CLIENTS = ['codex', 'cursor'];
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : '';
};
export const allowed = (cwd) => !!repoFor(cwd);
/**
 * Since when the folder is allowed (`merle-runner allow` writes `at`), or null when it isn't: what was written in it
 * before then is never read. A folder allowed before allow wrote `at` counts from 0 (that was before reading existed).
 */
export const allowedSince = (cwd) => {
  const r = repoFor(cwd);
  return r ? (Number.isSafeInteger(r.at) && r.at > 0 ? r.at : 0) : null;
};
/** The Merle product this Mac allowed the folder for, as the person typed it there: the session is bound to it. */
const productFor = (cwd) => {
  const p = repoFor(cwd)?.product;
  return typeof p === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(p) ? p : undefined;
};
const worktreeOf = (cwd) => basename(git(cwd, ['rev-parse', '--show-toplevel']) || resolve(cwd));

/**
 * A hook's input as this script reads it, whichever agent ran it: its session id and its folder. Claude Code's is
 * taken as it is. Codex's carries the same names; only those two are kept, so nothing claims to know its permission
 * prompts. Cursor names the session `conversation_id` and gives its workspace's folders, not a `cwd` (its user hooks
 * run in ~/.cursor). A Cursor workspace hooks up only when every one of its folders is allowed, all for one product:
 * a note steers the whole workspace, so one folder the Mac never allowed keeps it out. Its `status` says how the turn
 * ended, and `loop_count` how many follow-ups Cursor already sent on its own.
 */
export function inputOf(raw, client) {
  if (client === 'codex') return { session_id: raw.session_id, cwd: raw.cwd };
  if (client !== 'cursor') return raw;
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
  const ok =
    roots.length > 0 &&
    roots.every((r) => typeof r === 'string' && isAbsolute(r) && allowed(r)) &&
    new Set(roots.map((r) => productFor(r) ?? '')).size === 1;
  return {
    session_id: raw.conversation_id ?? raw.session_id,
    cwd: ok ? roots[0] : undefined,
    status: raw.status,
    loop_count: raw.loop_count,
  };
}
/** Follow-ups Cursor sends on its own in a row before it ignores a stop hook's (`loop_limit`, its default 5). */
export const CURSOR_LOOPS = 5;
/** What a hook prints for the agent: the words in the shape each one reads at that event. */
export function outputOf(client, event, words) {
  if (client === 'cursor')
    return event === 'SessionStart' ? { additional_context: words } : { followup_message: words };
  if (client === 'codex' && event === 'Stop') return { decision: 'block', reason: words };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: words } };
}

/** This Mac's own settings, read by the runner's code: it asks for signed stops on the same setting. */
const settings = hookSettings;
const setSettings = (v) => {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(SETTINGS, `${JSON.stringify({ ...settings(), ...v })}\n`, { mode: 0o600 });
};
/** Once Merle has said notes are signed, this Mac asks for it until someone on the Mac says otherwise. */
/**
 * Whether this Mac takes only signed notes. Kept twice: in the settings file and with the pairing in the Keychain, so
 * deleting the file can't turn it off. Either one says on, it's on.
 */
const required = signingRequired;
const setRequired = (on) => {
  setSettings({ requireSigned: on });
  const pin = kept();
  if (pin) keep({ ...pin, requireSigned: on });
};
/** This session's own record on the Mac: its full id, and whether it was unhooked here. */
const sessionFile = (short) => join(SESSIONS, `${short}.json`);
const local = (short) => {
  try {
    const v = JSON.parse(readFileSync(sessionFile(short), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const saveLocal = (short, v) => {
  mkdirSync(SESSIONS, { recursive: true });
  // Written whole and moved into place: the runner reading it meanwhile never sees it half written.
  const to = sessionFile(short);
  const tmp = `${to}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...local(short), ...v }), { mode: 0o600 });
  renameSync(tmp, to);
};
/** Unhooked here (/merle unhook): it takes nothing, whatever Merle says, until it's hooked up here again. */
export const unhookedHere = (input) => local(shortOf(input.session_id)).unhooked === true;
const ratchet = (signed) => {
  if (signed !== true || required()) return;
  setRequired(true);
  try {
    logNote({ event: 'signing', on: true, by: 'merle' });
  } catch {}
};
/** Claude Code's permission modes, as a hook's input names them; and the ones in which it still asks before a tool. */
const MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'];
const ASKS = new Set(['default', 'plan', 'acceptEdits']);
/** Whether this session still asks before a tool runs. Unknown counts as no: nothing claims prompts it can't see. */
const prompts = (input) => ASKS.has(input.permission_mode);
const SHORT_ID = /^[a-z0-9]{8}$/;

const logWritable = () => {
  try {
    mkdirSync(dirname(NOTES_LOG), { recursive: true });
    accessSync(dirname(NOTES_LOG), constants.W_OK);
    if (existsSync(NOTES_LOG)) accessSync(NOTES_LOG, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
const logNote = (entry) =>
  appendFileSync(NOTES_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
    mode: 0o600,
  });

export const api = async (pin, path, init = {}, ms = 10_000) => {
  const r = await fetch(`${pin.origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pin.token}` },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw Object.assign(new Error(`merle ${r.status}`), { status: r.status });
  return r.json();
};

/** Why this Mac won't take a note, or null. */
export function refusalOf(note, a, pin, { session, agent = null, requireSigned, now }) {
  if (!note || note.v !== 1) return 'version';
  if (note.type !== 'note') return 'type';
  if (Object.keys(note).some((k) => !NOTE_KEYS.has(k))) return 'keys';
  const shape =
    typeof note.id === 'string' &&
    NOTE_ID.test(note.id) &&
    (note.kind === 'note' || note.kind === 'approved') &&
    typeof note.text === 'string' &&
    note.text.length <= 4000 &&
    typeof note.from === 'string' &&
    /^[A-Za-z0-9_-]{1,60}$/.test(note.from) &&
    typeof note.paired === 'boolean' &&
    Array.isArray(note.refs) &&
    note.refs.every((r) => typeof r === 'string' && /^R-\d{1,9}$/.test(r)) &&
    (note.agent === undefined || (typeof note.agent === 'string' && AGENT_KEY.test(note.agent)));
  if (!shape) return 'shape';
  if (note.runner !== pin.runner) return 'runner';
  if (note.session !== session) return 'session';
  // A teammate's note only in that teammate's own hook; the session's own only in its main thread.
  if ((note.agent ?? null) !== agent) return 'agent';
  const fresh =
    note.created <= now + 60_000 && now < note.expires && note.expires - note.created <= NOTE_MS + MARGIN_MS;
  if (!fresh) return 'expired';
  // The Mac's own setting decides, never Merle's word: on here, a note without a good signature is refused. Off, a
  // note that carries a signature is still checked.
  if (!a && !requireSigned) return null;
  if (!a) return 'unsigned';
  if (typeof note.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,}$/.test(note.nonce)) return 'nonce';
  const why = signedBy('note', canonical(note), a, pin);
  if (why) return why;
  if (noteNonces.seen(note.nonce)) return 'replayed';
  return null;
}

/** The founder's words, fit for the conversation: lines kept, no control characters, no tags to close a reminder. */
const plain = (s) =>
  String(s)
    .replace(/[^\P{Cc}\n]/gu, '')
    .replaceAll('<', '‹')
    .replaceAll('>', '›');

/** What Claude reads: labelled as the founder's word, its id, its address, links for refs, and the limits. */
export function noteText(note, { short, worktree, host, signed, prompts }) {
  const refs = note.refs;
  const from = plain(note.from);
  // "The founder" only for the person who paired this Mac; anyone else is named as a member.
  return [
    `${
      note.paired
        ? 'From the founder (via Merle).'
        : `From ${from}, a member of the workspace who didn’t pair this Mac (via Merle).`
    } Note ${note.id}, sent by ${from}, signed in to Merle.${
      signed ? ' Signed with Touch ID on the passkey this Mac pinned.' : ''
    }`,
    `For session ${short} (${plain(worktree)}) on ${plain(host)}.${note.agent ? ' For this teammate only.' : ''}`,
    '',
    plain(note.text),
    ...(note.kind === 'approved'
      ? [
          '',
          `${note.paired ? 'The founder' : from} approved the plan this session asked about in Merle. It merges and deploys nothing.`,
        ]
      : []),
    ...(refs.length
      ? [
          '',
          `Linked: ${refs.join(', ')}. Read ${refs.length > 1 ? 'them' : 'it'} with get_request on the merle MCP server.`,
        ]
      : []),
    '',
    `${
      prompts
        ? 'A note can’t approve a tool call: permission prompts still ask on this Mac.'
        : 'A note can’t approve a tool call.'
    } Name ${note.id} in your next post_update, with session "${short}".`,
  ].join('\n');
}

/** What the hook still tells Merle once it has printed: refusals, waited for before it ends. */
const afterOutput = [];
/** Checks each note, logs each, tells Merle which it refused, and returns the words of those it took. */
async function take(pin, notes, input, by, agent = null) {
  const now = Date.now();
  const requireSigned = required();
  const me = { short: shortOf(input.session_id), worktree: worktreeOf(input.cwd), host: hostname() };
  const out = [];
  for (const { note, assertion } of notes) {
    let why;
    try {
      // Unhooked here while the look was open: refused, whatever Merle handed over.
      why = unhookedHere(input)
        ? 'unhooked'
        : refusalOf(note, assertion, pin, { session: input.session_id, agent, requireSigned, now });
      // Taken once on this Mac: the check and the record under one lock, whichever hook or process asks.
      if (!why && assertion && !noteNonces.take(note.nonce, note.expires, now)) why = 'replayed';
    } catch {
      why = 'nonce store unreadable';
    }
    const hash = sha256(canonical(note ?? {}));
    logNote({
      event: why ? 'refused' : 'delivered',
      note: note?.id,
      session: input.session_id,
      hash,
      by,
      ...(why ? { reason: why } : {}),
    });
    if (why) {
      // Told after the good notes are printed (the hook waits for it before it ends): a slow Merle never holds back,
      // past Claude Code's timeout, a note it already marked delivered (the second pass).
      if (typeof note?.id === 'string' && NOTE_ID.test(note.id))
        afterOutput.push(
          api(pin, `/v1/runner/hook/notes/${note.id}/refused`, {
            method: 'POST',
            body: JSON.stringify({ reason: why }),
          }).catch(() => {}),
        );
      continue;
    }
    out.push(noteText(note, { ...me, signed: !!assertion, prompts: prompts(input) }));
  }
  return out;
}

/** The Mac is paired, the folder allowed, the session id sane: the pin; otherwise null, and the hook does nothing. */
export const ready = (input) => {
  if (typeof input.session_id !== 'string' || !SESSION_ID.test(input.session_id)) return null;
  if (typeof input.cwd !== 'string') return null;
  const pin = kept();
  if (!pin?.token || !pin.origin || !pin.runner) return null;
  return allowed(input.cwd) ? pin : null;
};
/** Checks the session in, and keeps its id on the Mac, so /merle unhook finds it however it first checked in. */
const checkin = (pin, input, event, client) =>
  postCheckin(pin, input, event, client).then(async (r) => {
    // Its folder too, kept here only: the runner checks reading's folder rules again before a name leaves.
    saveLocal(shortOf(input.session_id), {
      session: input.session_id,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    // A session's first start: the event hook ran beside this one, before its record was here, and left nothing.
    if (event === 'start')
      await import('./event.mjs').then((e) => e.spool(e.factOf(input), input.cwd)).catch(() => false);
    return r;
  });
const postCheckin = (pin, input, event, client) =>
  api(pin, '/v1/runner/hook/checkin', {
    method: 'POST',
    body: JSON.stringify({
      session: input.session_id,
      event,
      name: String(input.session_title ?? '') || worktreeOf(input.cwd),
      worktree: worktreeOf(input.cwd),
      branch: git(input.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined,
      ...(MODES.includes(input.permission_mode) ? { mode: input.permission_mode } : {}),
      ...(productFor(input.cwd) ? { product: productFor(input.cwd) } : {}),
      ...(OTHER_CLIENTS.includes(client) ? { client } : {}),
      // Claude Code's plugin only: Codex and Cursor run these hooks from Merle's download, with no plugin to update.
      ...(PLUGIN_VERSION && client === undefined ? { plugin: PLUGIN_VERSION } : {}),
      ...(HOOKS_SHA && client === undefined ? { hooks: HOOKS_SHA } : {}),
      // Claude Code's plugin holds the pause gate (pause-gate.mjs, its PreToolUse hook): Merle offers Pause only then.
      // And whether this session's pause file is here, by the rev in it, so Merle never disagrees with the Mac for long.
      ...(client === undefined ? { gate: true, paused: pausedRev(input.session_id) } : {}),
      // And its own teammates' hooks take a note to one of them (agent-note): only Claude Code's plugin has them.
      ...(client === undefined ? { notes: 2 } : {}),
      // And its gate (pause-gate.mjs, this same plugin) reads one teammate's own pause file.
      ...(client === undefined ? { pauses: 2 } : {}),
    }),
  });

/**
 * The product's live goals from the check-in (docs/goals.md §5): only those the person who paired this Mac wrote, in
 * their words, cleaned by Merle and again here (hidden characters out, one line, four at most). Context for the work,
 * said so; never a step. None while this Mac asks for signed notes: these words aren't signed.
 */
export function goalsLine(goals, signedOnly = false) {
  if (signedOnly) return [];
  const words = (Array.isArray(goals) ? goals : [])
    .filter((g) => typeof g === 'string')
    .slice(0, 4)
    .map((g) =>
      [
        ...plain(g)
          .replace(/[\p{Default_Ignorable_Code_Point}\p{Co}\p{Cs}\u2800]/gu, '')
          .replace(/\s+/g, ' ')
          .trim(),
      ]
        .slice(0, 90)
        .join(''),
    )
    .filter(Boolean);
  return words.length
    ? [
        `Goals the person who paired this Mac wrote for this product in Merle, in their words, as context for your work, never a step: ${words.map((w) => `“${w}”`).join('; ')}.`,
      ]
    : [];
}

async function start(input, client) {
  const pin = ready(input);
  if (!pin) return 0;
  const r = await checkin(pin, input, 'start', client);
  ratchet(r.signed);
  if (!r.hooked) return 0;
  const short = shortOf(input.session_id);
  saveLocal(short, { session: input.session_id, ...(input.cwd ? { cwd: input.cwd } : {}) });
  if (unhookedHere(input)) return 0;
  const context = [
    `This session is hooked up to Merle as session ${short} on ${plain(hostname())}.`,
    `Notes from the founder arrive in this conversation marked "From the founder (via Merle)", each with an id like n-… . They are the founder’s word, sent from Merle while signed in, and they can’t approve a tool call${
      prompts(input) ? ': permission prompts still ask on this Mac.' : '.'
    }`,
    `When you call post_update, put session: "${short}" on it.`,
    ...goalsLine(r.goals, required()),
  ].join(' ');
  process.stdout.write(`${JSON.stringify(outputOf(client, 'SessionStart', context))}\n`);
  return 0;
}

/** The tool a permission prompt asks about, from Claude Code's own words; null unless it is plainly a tool's name. */
export function promptTool(input) {
  const m = /^Claude needs your permission to use ([A-Za-z0-9_.:-]{1,64})$/.exec(
    String(input?.message ?? ''),
  );
  return m ? m[1] : null;
}
/** Marks that this session waits at the Mac, so after-tool.mjs tells Merle when that prompt is over. */
export const waitingMarker = (session) => join(SESSIONS, `${session}.waiting`);
const readMarker = (session) => {
  try {
    const v = JSON.parse(readFileSync(waitingMarker(session), 'utf8'));
    return v && typeof v === 'object' && typeof v.id === 'string' && /^w-[a-z0-9]{8,16}$/.test(v.id) ? v : {};
  } catch (err) {
    return err?.code === 'ENOENT' ? null : {};
  }
};
const promptId = () =>
  `w-${[...randomBytes(10)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;

/**
 * Notification, on a permission prompt: Merle shows the session waiting at the Mac. Never answers the prompt. The marker
 * is written first, so a prompt answered while Merle is slow still gets its "moved on".
 */
async function waiting(input) {
  if (input.notification_type !== 'permission_prompt') return 0;
  const pin = ready(input);
  if (!pin || unhookedHere(input)) return 0;
  const tool = promptTool(input);
  const id = promptId();
  mkdirSync(SESSIONS, { recursive: true });
  // What a hook that died left beside this session's marker (a half-written one, or one moved aside to be dropped)
  // goes with the session's next prompt, once it is a minute old. A moved-aside one keeps the marker's own time, so it
  // can be taken while its hook still runs; that only ever takes a marker a new one replaces now.
  const at = waitingMarker(input.session_id);
  let names = [];
  try {
    names = readdirSync(SESSIONS).filter((n) => n.startsWith(`${input.session_id}.waiting.`));
  } catch {}
  for (const n of names)
    try {
      const f = join(SESSIONS, n);
      if (Date.now() - statSync(f).mtimeMs > 60_000) rmSync(f, { force: true });
    } catch {}
  // Written whole, then put in place in one step, so the hook that drops a marker never reads half of one. A file of
  // its own (O_EXCL), as the pause file is: never written through a link left in its place.
  const tmp = `${at}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, JSON.stringify({ id, ...(tool ? { tool } : {}) }), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, at);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  await api(pin, '/v1/runner/hook/waiting', {
    method: 'POST',
    body: JSON.stringify({ session: input.session_id, id, ...(tool ? { tool } : {}) }),
  });
  return 0;
}
/** post_update however it is installed: `mcp__merle__…`, `mcp__plugin_merle_merle__…`, a server renamed. */
export const POST_UPDATE = /^mcp__[A-Za-z0-9_-]+__post_update$/;
/** post_update's own block for an ask (copy-mcp.ts `MCP.said.ask`): the id, then Merle's short fixed sentence. */
const ASK_BLOCK = /^Merle ask (k-[a-z]{10}): [^\n]{1,100}$/;
/**
 * Where an agent's ask was made (after-tool.mjs, after post_update): the ask id Merle put in the tool's own answer, and
 * Claude Code's id for this session, go to Merle with this Mac's token, so a person's answer comes back here only.
 * Nothing else of the call leaves: not what the agent sent, not the rest of the answer. One such block exactly, or nothing.
 */
export async function askedHere(input) {
  if (input?.hook_event_name !== 'PostToolUse' || !POST_UPDATE.test(String(input?.tool_name ?? ''))) return 0;
  if (typeof input?.session_id !== 'string' || !SESSION_ID.test(input.session_id)) return 0;
  // Only a content block of its own, all of it Merle's fixed words: an id inside other words (a proposal's title or a
  // question echoed in the reply) is never read, and can't block the real one either.
  const r = input.tool_response;
  const blocks = Array.isArray(r) ? r : Array.isArray(r?.content) ? r.content : [];
  const ids = blocks
    .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? ASK_BLOCK.exec(b.text)?.[1] : undefined))
    .filter(Boolean);
  if (ids.length !== 1) return 0;
  const pin = ready(input);
  if (!pin || unhookedHere(input)) return 0;
  await api(
    pin,
    '/v1/runner/hook/ask',
    { method: 'POST', body: JSON.stringify({ session: input.session_id, ask: ids[0] }) },
    2_000,
  ).catch(() => null);
  return 0;
}
/**
 * The prompt is over (after-tool.mjs): after the tool it asked about, or whenever the person types or Claude waits for
 * them (`any`). Merle stops showing it waiting. The marker goes once Merle took it (or no longer knows the session), so
 * a Merle that didn't answer hears it with the next tool.
 */
export async function answered(input, any = false) {
  if (typeof input?.session_id !== 'string' || !SESSION_ID.test(input.session_id)) return 0;
  const m = readMarker(input.session_id);
  if (m === null) return 0;
  if (!any && typeof m.tool === 'string' && input.tool_name !== m.tool) return 0;
  // Only while the marker is still this prompt's: a newer prompt written meanwhile keeps its own, to be told in turn.
  // Moved aside first (one step), read there, and put back without overwriting when it is another prompt's, so a newer
  // marker written at any moment is never the one deleted.
  const drop = () => {
    const at = waitingMarker(input.session_id);
    const aside = `${at}.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      renameSync(at, aside);
    } catch {
      return; // gone already
    }
    let v = null;
    try {
      v = JSON.parse(readFileSync(aside, 'utf8'));
    } catch {}
    const same =
      !v ||
      typeof v !== 'object' ||
      typeof v.id !== 'string' ||
      !/^w-[a-z0-9]{8,16}$/.test(v.id) ||
      v.id === m.id;
    if (!same)
      try {
        linkSync(aside, at); // never over a marker written since: that one is newer still
      } catch {}
    rmSync(aside, { force: true });
  };
  // A Merle that hasn't taken it for a quarter of an hour isn't asked again with every tool: its next check-in clears it.
  let old = false;
  try {
    old = Date.now() - statSync(waitingMarker(input.session_id)).mtimeMs > 15 * 60_000;
  } catch {}
  const pin = old ? null : ready(input);
  if (!pin || unhookedHere(input) || !m.id) {
    drop();
    return 0;
  }
  try {
    await api(
      pin,
      '/v1/runner/hook/waiting',
      { method: 'POST', body: JSON.stringify({ session: input.session_id, id: m.id, answered: true }) },
      3_000,
    );
    drop();
  } catch (err) {
    if (err?.status === 404) drop();
  }
  return 0;
}

async function nextNote(input, client) {
  const pin = ready(input);
  if (!pin || !logWritable() || unhookedHere(input)) return 0;
  const r = await checkin(pin, input, 'stop', client);
  ratchet(r.signed);
  if (!r.hooked) return 0;
  // Cursor sends a note as the next message from the person: never after they stopped the turn or it failed, and
  // never once it has sent as many follow-ups as it will (it would drop the note after Merle marked it delivered).
  if (
    client === 'cursor' &&
    (input.status !== 'completed' || !(Number(input.loop_count ?? 0) < CURSOR_LOOPS))
  )
    return 0;
  const got = await api(pin, `/v1/runner/hook/notes?session=${input.session_id}&wait=0`);
  ratchet(got.signed);
  const words = await take(pin, got.notes ?? [], input, 'stop');
  if (!words.length) return 0;
  process.stdout.write(`${JSON.stringify(outputOf(client, 'Stop', words.join('\n\n---\n\n')))}\n`);
  return 0;
}

/**
 * A note to one teammate, in that teammate's own hooks (Claude Code's SubagentStart and SubagentStop, fired with its
 * `agent_id`): asked for by its key alone, so the session's own notes and another teammate's never come, and checked as
 * any note, its key included. As it takes a message, it's context; as it ends a turn, it's its next instruction.
 */
async function agentNote(input) {
  const pin = ready(input);
  if (!pin || !logWritable() || unhookedHere(input)) return 0;
  const { subOf } = await import('./event.mjs');
  const agent = subOf(input.session_id, input.agent_id);
  const got = await api(pin, `/v1/runner/hook/notes?session=${input.session_id}&agent=${agent}&wait=0`);
  ratchet(got.signed);
  const words = await take(pin, got.notes ?? [], input, 'agent', agent);
  if (!words.length) return 0;
  const text = words.join('\n\n---\n\n');
  const out =
    input.hook_event_name === 'SubagentStart'
      ? { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } }
      : { decision: 'block', reason: text };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

/** One waiter per session: the newest. An older one sees the pid file name another and ends. */
async function wait(input) {
  const pin = ready(input);
  if (!pin) return 0;
  mkdirSync(SESSIONS, { recursive: true });
  const mine = join(SESSIONS, `wait-${shortOf(input.session_id)}.pid`);
  writeFileSync(mine, String(process.pid), { mode: 0o600 });
  const still = () => {
    try {
      return readFileSync(mine, 'utf8') === String(process.pid);
    } catch {
      return false;
    }
  };
  for (;;) {
    if (!still() || process.ppid === 1) return 0; // replaced, or the session that started it is gone
    // The folder is checked again before every look: one taken off the Mac's list gets no more notes.
    if (!allowed(input.cwd) || !kept()?.token) return 0;
    const t = Date.now();
    if (!logWritable() || unhookedHere(input)) {
      await sleep(WAIT * 1000);
      continue;
    }
    let got;
    try {
      got = await api(
        pin,
        // With its word on the pause file, as a check-in gives it: a Resume its runner can't apply waits on it.
        `/v1/runner/hook/notes?session=${input.session_id}&wait=${WAIT}&paused=${pausedRev(input.session_id) ?? 'none'}`,
        {},
        (WAIT + 15) * 1000,
      );
    } catch (err) {
      if (err?.status === 401) return 0; // the Mac was removed
      // Not checked in yet (its SessionStart never reached Merle, and next-note may still be on it): check in, then
      // look again. A check-in Merle refuses (another Mac's session) ends it.
      if (err?.status === 404) {
        const ok = await checkin(pin, input, 'stop', undefined).then(
          () => true,
          () => false,
        );
        if (!ok) return 0;
      }
      await sleep(WAIT * 1000);
      continue;
    }
    if (got.unhooked) {
      // Nothing reaches it while it's unhooked. It keeps looking, slowly, so Hook up in Merle reaches it again.
      await sleep(WAIT * 4000);
      continue;
    }
    ratchet(got.signed);
    // Merle handed these over once and won't again: deliver them even if a newer waiter took over meanwhile.
    const words = await take(pin, got.notes ?? [], input, 'wait');
    if (words.length) {
      if (still()) rmSync(mine, { force: true });
      process.stderr.write(`${words.join('\n\n---\n\n')}\n`);
      return 2; // wakes the session (asyncRewake)
    }
    const left = WAIT * 1000 - (Date.now() - t);
    if (left > 0) await sleep(left); // never faster than one look per WAIT, whatever answers
  }
}

/** /merle unhook and /merle hookup: this session in Merle, by its id, with this Mac's token. */
async function hook(what, short) {
  if (!SHORT_ID.test(String(short))) {
    console.log(
      'Give the session’s id in Merle: 8 letters and digits, as Merle’s plugin said when the session started.',
    );
    return 1;
  }
  const pin = kept();
  if (!pin?.token) {
    console.log('This Mac isn’t paired with Merle, so no session on it is hooked up.');
    return 0;
  }
  let session;
  try {
    session = local(short).session;
    if (!session) throw Error('none');
  } catch {
    console.log(`No session ${short} has checked in on this Mac.`);
    return 1;
  }
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return 1;
  // Unhooked here first, so nothing reaches it even if Merle doesn't answer; hooked up here only once Merle has.
  if (what === 'unhook') saveLocal(short, { unhooked: true });
  await api(pin, `/v1/runner/hook/${what}`, { method: 'POST', body: JSON.stringify({ session }) });
  if (what === 'hookup') saveLocal(short, { unhooked: false });
  console.log(
    what === 'unhook'
      ? `Unhooked session ${short}. Notes from Merle no longer reach it. To hook it up again, run /merle hookup here.`
      : `Hooked up session ${short} again. Notes from Merle reach it.`,
  );
  return 0;
}

/**
 * Only signed notes on this Mac, or not. On can come from anywhere, the safe way. Off needs a person at this Mac: a
 * terminal (Claude's Bash tool has none) and the word typed. Both go to the note log here and to Merle's audit.
 */
/**
 * Off needs the passkey this Mac pinned: Merle asks the person who paired it to sign "signing-off" with Touch ID on its
 * Sessions page, and this Mac checks the signature itself, as it checks a job or a note (signedBy).
 */
async function passkeySaysOff(pin) {
  return passkeySays(pin, 'signing-off', (path, init, ms) => api(pin, path, init, ms), noteNonces);
}

async function signing(on) {
  if (!on) {
    if (!process.stdin.isTTY) {
      console.log('Turning this off needs you at the Mac: run it in a terminal yourself.');
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const word = (await rl.question('Type off to take notes on this Mac without Touch ID: '))
      .trim()
      .toLowerCase();
    rl.close();
    if (word !== 'off') {
      console.log('Left on. This Mac takes only notes signed with Touch ID.');
      return 1;
    }
  }
  if (!logWritable()) {
    console.log('This Mac can’t write its note log, so nothing changed.');
    return 1;
  }
  if (!on && kept()?.token && !(await passkeySaysOff(kept()))) {
    console.log('Left on. This Mac takes only notes signed with Touch ID.');
    return 1;
  }
  setRequired(on);
  logNote({ event: 'signing', on, by: 'mac' });
  const pin = kept();
  const told = pin?.token
    ? await api(pin, '/v1/runner/hook/signing', { method: 'POST', body: JSON.stringify({ on }) }).then(
        () => true,
        () => false,
      )
    : false;
  console.log(
    on
      ? 'This Mac takes only notes signed with Touch ID.'
      : 'This Mac takes notes from a signed-in person without Touch ID, unless Merle asks for it again.',
  );
  if (pin?.token && !told)
    console.log('Merle didn’t answer, so its audit doesn’t have this yet. The log here does.');
  return 0;
}

/**
 * Fired inside a subagent or an in-process teammate (Claude Code's `agent_id`): its hooks carry the session's own id, so
 * a note the founder sent the session must never land in one of them. Only the session's main thread takes notes.
 */
const insideAgent = (input) => typeof input?.agent_id === 'string' && input.agent_id.length > 0;

async function main([cmd, arg]) {
  switch (cmd) {
    case 'start':
    case 'next-note': {
      // No word after it: Claude Code's plugin. Codex or Cursor: merle-runner hooks wrote it. Anything else does nothing.
      if (arg !== undefined && !OTHER_CLIENTS.includes(arg)) return 0;
      const raw = readInput();
      // Claude Code's field: another client's input with the same name never holds back the session's note.
      if (cmd === 'next-note' && arg === undefined && insideAgent(raw)) return 0;
      const input = inputOf(raw, arg);
      return cmd === 'start' ? start(input, arg) : nextNote(input, arg);
    }
    case 'agent-note': {
      // Claude Code's plugin only, and only inside a teammate or a subagent: anything else asks for nothing.
      if (arg !== undefined) return 0;
      const input = readInput();
      const e = input?.hook_event_name;
      return insideAgent(input) && (e === 'SubagentStart' || e === 'SubagentStop') ? agentNote(input) : 0;
    }
    case 'wait': {
      const input = readInput();
      return insideAgent(input) ? 0 : wait(input);
    }
    case 'waiting':
      return waiting(readInput());
    case 'unhook':
    case 'hookup':
      return hook(cmd, arg ?? '');
    case 'signing':
      if (arg !== 'on' && arg !== 'off') {
        console.log('session-hook.mjs signing on|off');
        return 1;
      }
      return signing(arg === 'on');
    default:
      console.log(
        'session-hook.mjs start [codex|cursor] | next-note [codex|cursor] | wait | unhook <id> | hookup <id> | signing on|off',
      );
      return 1;
  }
}

// A hook that fails says nothing and lets the session go on: the note waits in Merle for the next turn.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2))
    .then(async (code) => {
      // Refusals get two seconds at most: Claude Code keeps a hook's output only if it ends inside its timeout, and the
      // note already printed is marked delivered (the review team). One that doesn't make it in time stays marked
      // delivered in Merle; the Mac's notes log keeps the refusal.
      const enough = new Promise((done) => setTimeout(done, 2000).unref()); // honesty: a hook's exit wait; moves no stage
      await Promise.race([Promise.all(afterOutput), enough]);
      return code;
    })
    .then(
      (code) => process.exit(code ?? 0),
      () => process.exit(0),
    );
