#!/usr/bin/env node
/**
 * Session reading at the end of a turn (docs/sessions.md, Session reading): Claude Code's Stop hook, in the background,
 * and its SessionEnd hook, which sends a session's last turn without waiting out the two minutes.
 *
 * Only while reading is on (merle-runner `reading on`: a signed "reading-on" ask on file) and the session's folder is
 * allowed and not left out. It reads the session's own record from where it last stopped, keeps only entries written
 * since reading was on and in a folder it reads, applies the allowlist (runner/reading.mjs), scrubs every line with
 * Merle's own scrubber, caps the send at 8 KB, and sends it with the Mac's token at most once every two minutes per
 * session. Each send is a line in ~/Library/Logs/Merle/reading.jsonl (a hash, bytes and counts, never the words); the
 * words stay in `reading/<session>.last` for `merle-runner reading show`. A send Merle doesn't take waits two minutes
 * and goes again from the same place; one Merle says it doesn't take at all (404) is passed over, with every turn of the
 * hour after it, or until reading is signed afresh.
 *
 * While reading is off, the folder isn't read or the session is unhooked, its place in the record moves to the end, so nothing written then
 * leaves later. It prints nothing: a Stop hook's output can steer the session, and this one never does.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_DIR, readingLeftOut, readingLog, readingSince, tellOff } from '../runner/merle-runner.mjs';
import { entriesOf, extract, render } from '../runner/reading.mjs';
import { allowedSince, api, ready, unhookedHere } from './session-hook.mjs';

/** At most one send per session in this long; a send Merle didn't take waits as long. */
export const EVERY_MS = 2 * 60_000;
/** Merle doesn't take reading at all (it answered 404): look again in an hour, or once reading is signed afresh. */
const CLOSED_MS = 60 * 60_000;
/** A turn's new lines are read up to this many bytes at once; the rest waits for the next turn. */
export const READ_MAX =
  Number(process.env.MERLE_READ_MAX) > 0 ? Number(process.env.MERLE_READ_MAX) : 4 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
/** How long a send waits for Merle: longer than Merle waits for its model (reading.ts READ_MS). */
export const READ_WAIT_MS = 20_000;

/** Where Claude Code keeps its records: a session's own file, and nothing else, is ever read. */
const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
/** The session's own record, by the path Claude Code gave: only a `<session id>.jsonl` under its projects folder. */
export function recordOf(input) {
  const p = input?.transcript_path;
  if (typeof p !== 'string' || typeof input.session_id !== 'string' || !SESSION_ID.test(input.session_id))
    return null;
  let real;
  let root;
  try {
    real = realpathSync(p);
    root = realpathSync(projectsDir());
  } catch {
    return null;
  }
  if (!real.startsWith(root + sep) || !real.endsWith(`${sep}${input.session_id}.jsonl`)) return null;
  return real;
}

const stateFile = (session) => join(READ_DIR, `${session}.json`);
const stateOf = (session) => {
  try {
    const v = JSON.parse(readFileSync(stateFile(session), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const keep = (path, text) => {
  mkdirSync(READ_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
};
const save = (session, v) => keep(stateFile(session), JSON.stringify(v));

/** The record's first line's hash: a record replaced by another reads from its start. */
const headOf = (path) => {
  const buf = Buffer.alloc(4096);
  const fd = openSync(path, 'r');
  let n = 0;
  try {
    n = readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  const end = buf.subarray(0, n).indexOf(0x0a);
  return createHash('sha256')
    .update(buf.subarray(0, end < 0 ? n : end))
    .digest('hex')
    .slice(0, 16);
};

/** The record's whole new lines from `offset`: their text and where the next read starts. */
function newLines(path, offset) {
  const size = statSync(path).size;
  const n = Math.min(size - offset, READ_MAX);
  if (n <= 0) return { text: '', next: offset, skipped: false };
  const buf = Buffer.alloc(n);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, n, offset);
  } finally {
    closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a) + 1; // only whole lines: a line still being written waits
  // One line longer than a whole read (a huge result): skipped, so the record never stops being read.
  if (end === 0 && n === READ_MAX) return { text: '', next: offset + n, skipped: true };
  return { text: buf.subarray(0, end).toString('utf8'), next: offset + end, skipped: false };
}

/**
 * One turn at a time per session: a lock file made with O_EXCL holding this hook's own mark. One left by a dead hook is
 * taken over after a minute in steps that can't take a live one: moved aside, checked stale there, put back if it
 * wasn't. On release only this hook's own lock goes, never one another hook holds.
 */
export function locked(session, fn) {
  mkdirSync(READ_DIR, { recursive: true });
  const lock = join(READ_DIR, `${session}.lock`);
  const mine = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const take = () => {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };
  const old = (path) => {
    try {
      return Date.now() - statSync(path).mtimeMs >= 60_000;
    } catch {
      return false;
    }
  };
  if (!take()) {
    if (!old(lock)) return Promise.resolve('busy');
    const aside = `${lock}.${mine}`;
    try {
      renameSync(lock, aside);
    } catch {
      return Promise.resolve('busy');
    }
    const stale = old(aside);
    if (!stale)
      try {
        linkSync(aside, lock); // a live hook's, taken meanwhile: back where it was, never over a newer one
      } catch {}
    rmSync(aside, { force: true });
    if (!stale || !take()) return Promise.resolve('busy');
  }
  return fn().finally(() => {
    const aside = `${lock}.${mine}.done`;
    try {
      renameSync(lock, aside);
    } catch {
      return;
    }
    let v = '';
    try {
      v = readFileSync(aside, 'utf8');
    } catch {}
    if (v !== mine)
      try {
        linkSync(aside, lock);
      } catch {}
    rmSync(aside, { force: true });
  });
}

/**
 * One turn's end (`last`: the session ended, so its last turn goes without waiting out the two minutes). Returns what it
 * did, for the tests: `off`, `busy`, `wait`, `nothing`, `unreadable`, `sent` or `failed`.
 */
export async function readTurn(input, now = Date.now(), last = false) {
  const path = recordOf(input);
  const pin = ready(input);
  if (!path) return 'off';
  // Not read here now (a folder not allowed, the Mac not paired, the session unhooked here): its place still moves to
  // the end, so nothing written meanwhile leaves once it is read again.
  if (!pin || unhookedHere(input))
    return locked(input.session_id, async () => {
      save(input.session_id, {
        ...stateOf(input.session_id),
        offset: statSync(path).size,
        head: headOf(path),
      });
      return 'off';
    });
  return locked(input.session_id, async () => {
    await tellOff().catch(() => false);
    const st = stateOf(input.session_id);
    const head = headOf(path);
    const since = readingSince(pin);
    if (since === null || readingLeftOut(input.cwd)) {
      // Not read now: the place moves to the end, so nothing written while off leaves when it's on again.
      save(input.session_id, { ...st, offset: statSync(path).size, head });
      return 'off';
    }
    // The next look waits two minutes after a send or a failure, an hour after Merle said it takes none. A time ahead
    // of now (a clock set back) counts as long past.
    const after = (t, ms) => typeof t === 'number' && t <= now && now - t < ms;
    // That hour's turns are passed over, as the first was: each one's end moves its place on. A 404 from before reading was
    // turned on (signed afresh since) says nothing of now.
    if (after(st.closedAt, CLOSED_MS) && st.closedAt >= since) {
      save(input.session_id, { ...st, offset: statSync(path).size, head });
      return 'wait';
    }
    if (!last && (after(st.sentAt, EVERY_MS) || after(st.failedAt, EVERY_MS))) return 'wait';
    const from =
      Number.isSafeInteger(st.offset) && st.head === head && st.offset <= statSync(path).size ? st.offset : 0;
    const { text, next, skipped } = newLines(path, from);
    const { entries, bad } = entriesOf(text);
    // Only what was written since reading was on, in a folder this Mac reads and doesn't leave out.
    const folders = new Map();
    // Since when each folder is read: allowed and not left out, from when it was allowed (null: not read at all). Judged
    // by when an entry was written, never by when this reads it, so a folder allowed later never sends what came before.
    const readsFrom = (cwd) => {
      if (typeof cwd !== 'string') return null;
      if (!folders.has(cwd)) folders.set(cwd, readingLeftOut(cwd) ? null : allowedSince(cwd));
      return folders.get(cwd);
    };
    const keepIt = (e) => {
      const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
      const from = readsFrom(e.cwd);
      // This session's own turns: history copied in from another (a resumed session) stays out.
      return (
        from !== null &&
        at >= since &&
        at >= from &&
        (e.sessionId === undefined || e.sessionId === input.session_id)
      );
    };
    const x = extract(entries, keepIt);
    const dropped = x.dropped + bad + (skipped ? 1 : 0);
    // As it was when the record was read: the same on, and no folder it read from left out or no longer allowed since.
    const holds = () =>
      readingSince(pin) === since &&
      !readingLeftOut(input.cwd) &&
      [...folders].every(([f, at]) => at === null || (!readingLeftOut(f) && allowedSince(f) === at));
    /** Why nothing may leave now; null when it may. Unhooked here counts as Merle's 410, whether or not Merle heard it. */
    const stays = () => (unhookedHere(input) ? 'gone' : holds() ? null : 'off');
    const send = async (body) => {
      // Right before each thing leaves: an unhook, an off, a folder left out or a fresh signing typed meanwhile wins.
      const before = stays();
      if (before) return before;
      try {
        // Words leave only once Merle says, with no words sent, that it reads this session now: unhooked there, or
        // hooked up again after a gap, it answers 410 and nothing of the session goes (a Codex review).
        if (typeof body.text === 'string')
          await api(
            pin,
            '/v1/runner/hook/reading',
            { method: 'POST', body: JSON.stringify({ session: body.session, ready: true }) },
            READ_WAIT_MS,
          );
        const after = stays();
        if (after) return after;
        await api(
          pin,
          '/v1/runner/hook/reading',
          { method: 'POST', body: JSON.stringify(body) },
          READ_WAIT_MS,
        );
        return 'taken';
      } catch (err) {
        // 404: Merle takes no reading from this Mac (an hour), and its place moves to the end: what was written while
        // nothing read it never leaves once something does. 400 or 422: it won't take this send as it is (or its
        // model can't use it), so the turn is passed over rather than sent forever. 410: Merle doesn't read this session
        // now (unhooked), so its place moves to the end, as when reading is off. Anything else (409, 429, 5xx, no
        // answer): two minutes, same place.
        if (unhookedHere(input)) return 'gone';
        const code = err?.status;
        return code === 404
          ? 'closed'
          : code === 400 || code === 422
            ? 'refused'
            : code === 410
              ? 'gone'
              : 'failed';
      }
    };
    if (x.unknown) {
      // Turns of a shape it doesn't know (the record's format changed): nothing leaves but that this record can't be read.
      readingLog({ event: 'unreadable', session: input.session_id, dropped });
      const got = await send({ session: input.session_id, unreadable: true });
      if (got !== 'taken') {
        save(input.session_id, {
          ...st,
          head,
          ...(got === 'refused'
            ? { offset: next }
            : got === 'gone' || got === 'closed'
              ? { offset: statSync(path).size }
              : {}),
          ...(got === 'closed'
            ? { closedAt: now }
            : got === 'off' || got === 'gone'
              ? {}
              : { failedAt: now }),
        });
        return got === 'off' || got === 'gone' ? 'off' : 'failed';
      }
      save(input.session_id, { offset: next, head, sentAt: now });
      return 'unreadable';
    }
    const r = render(x.lines);
    if (!r.text) {
      save(input.session_id, { ...st, offset: next, head });
      return 'nothing';
    }
    const hash = createHash('sha256').update(r.text).digest('hex');
    const counts = {
      bytes: Buffer.byteLength(r.text),
      lines: x.lines.length,
      dropped,
      scrubbed: r.scrubbed,
      cut: r.cut,
    };
    readingLog({ event: 'sending', session: input.session_id, hash, ...counts }); // no line, no send (it throws)
    const got = await send({ session: input.session_id, text: r.text });
    if (got !== 'taken') {
      readingLog({
        event:
          got === 'off'
            ? 'off before it left'
            : got === 'refused'
              ? 'refused'
              : got === 'gone'
                ? 'not read now'
                : 'not taken',
        session: input.session_id,
        hash,
      });
      save(input.session_id, {
        ...st,
        head,
        ...(got === 'refused'
          ? { offset: next }
          : got === 'gone' || got === 'closed'
            ? { offset: statSync(path).size }
            : {}),
        ...(got === 'closed' ? { closedAt: now } : got === 'off' || got === 'gone' ? {} : { failedAt: now }),
      });
      return got === 'off' || got === 'gone' ? 'off' : 'failed';
    }
    // Its place first: a send Merle took is never sent again, even if what follows fails.
    save(input.session_id, { offset: next, head, sentAt: now });
    keep(join(READ_DIR, `${input.session_id}.last`), `${r.text}\n`);
    readingLog({ event: 'sent', session: input.session_id, hash, ...counts });
    return 'sent';
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {}
  // Never a word on stdout, and never a failed exit: the session goes on whatever happens here.
  readTurn(input, Date.now(), input?.hook_event_name === 'SessionEnd').then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
