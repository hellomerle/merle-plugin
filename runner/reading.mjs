/**
 * Session reading on the Mac (docs/sessions.md, Session reading): what may leave this Mac from
 * a Claude Code session's record, and nothing else.
 *
 * An allowlist, never a blocklist. Kept: what the person typed (a long paste, or one holding code, only as its
 * length), the agent's own words, the words of its questions, plans and to-dos (code they quote left out), and each
 * tool's name with whether it failed. Dropped, and counted: every tool input and output, thinking, images,
 * attachments, system and hook entries, anything Claude Code itself puts in a turn (reminders, slash commands and their
 * output, an editor's selection), Merle's own notes coming back, subagents' entries (`isSidechain`), summaries of a
 * compacted session, entries from before reading was on or from a folder it doesn't read, and any entry or block this
 * file doesn't know. Then the same scrubber as Merle's (scrub.mjs, generated from Merle's own scrub.ts), a rule of its
 * own for anything that looks like a setting with a value, and a cap.
 *
 * Turns whose shape it doesn't know send nothing: the session file isn't a published format, and a changed one must
 * never leak by accident.
 */
import { scrubber } from './scrub.mjs';

/** A typed message longer than this, or holding code, leaves only as its length. */
export const PASTE_MAX = 1000;
/** At most this many bytes of one send leave the Mac; the newest lines are kept. */
export const TURN_MAX = 8 * 1024;
/** One line of the agent's own words, at most, in characters. */
const LINE_MAX = 600;
/** How much of one line is read at all, before scrubbing: well past LINE_MAX, so a cut there hides no secret that leaves. */
const SCRUB_MAX = 2_000;
const TOOL = /^[A-Za-z0-9_.:-]{1,64}$/;
/** What Claude Code itself puts in a user turn: a block that opens with a tag. Never the person's words. */
const MACHINE = /^\s*<[a-z][a-z0-9_-]*[\s>/]/i;
/** Claude Code's own tags anywhere in a turn: the whole turn is dropped, whatever else it holds. */
const MACHINE_ANYWHERE =
  /<\/?(?:system-reminder|ide_selection|ide_opened_file|ide_diagnostics|command-[a-z]+|local-command-[a-z]+|bash-[a-z]+|task-notification|user-prompt-submit-hook|tool_use_error)\b/i;
/** Claude Code's own words in a user turn. */
const CLAUDE_SAYS = /^\s*\[Request interrupted by user/i;
/** Merle's own notes, coming back as what the session read (session-hook.mjs noteText). */
const MERLE_NOTE = /\(via Merle\)/;
/**
 * Code: a fenced block of ``` or ~~~, three or more, opened anywhere (taking too much costs nothing) and closed only
 * by a line of its own of the same mark at least as long, else it runs to the end, so neither a longer outer fence nor
 * a fence quoted inside the code ends it early; an indented block; inline code in any run of backticks, over lines too.
 * Each a linear
 * pass: runs of three or more are fences, so inline code only ever sees one or two.
 */
const FENCE = /((`|~)\2{2,})[\s\S]*?(?:\n[ \t]*\1\2*[ \t]*(?=\n|$)|$)/g;
const FENCED = /`{3,}|~{3,}/;
/**
 * A line indented as code: four spaces or a tab, at any depth, after any spaces. Pasted code nobody marked or indented
 * can't be told from words, and leaves as words (scrubbed like them).
 */
const INDENT = /(?:^|\n) *(?: {4}|\t)/;
/** In what the person typed, two spaces at a line's start are enough (a JSON or YAML block): a typed message is rarely
 * indented otherwise, and one taken for code only leaves as its length. */
const TYPED_INDENT = /(?:^|\n)(?: {2}| *\t)/;
const INDENTED = /(?:^|\n)(?: *(?: {4}|\t)[^\n]*(?:\n|$))+/g;
const INLINE = /(`+)[\s\S]*?\1/g;
/** Any case of a word, as a pattern: `key` matches key, Key and KEY, so the rest of a pattern can keep its case. */
const anyCase = (w) => w.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);
/**
 * A setting's name: ending in a word for a secret, any case, or going on after it only by `_` or a capital
 * (`DB_PASSWORD`, `clientSecretValue`, `passwordConfirmation`), so `passed` and `author` are words.
 */
const NAME = String.raw`[A-Za-z0-9_]*(?:${['key', 'token', 'secret', 'password', 'passwd', 'passphrase', 'pass', 'pwd', 'auth', 'credentials?'].map(anyCase).join('|')})(?:_[A-Za-z0-9_]*|[A-Z][A-Za-z0-9_]*)?`;
/** A quoted value, its quote escaped any number of times or not, whole, over lines too; one that never closes, all the rest. */
const QUOTED = String.raw`\$?\\*(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|${'`'}(?:[^${'`'}\\]|\\.)*${'`'}?)`;
/** A name in a setting's shape, not a label in prose (`Passkey:`, `OAuth:`): quoted, with `_`, camelCase, capitals, or a word for a password itself. */
const settingLike = (name, quote) =>
  !!quote ||
  name.includes('_') ||
  /[a-z][A-Z]/.test(name) ||
  !/[a-z]/.test(name) ||
  /^(?:password|passwd|passphrase|pwd|secret|token|credentials?)$/i.test(name);
/**
 * Anything that looks like a setting with a value, its name quoted or not, by = : => or := (`STRIPE_SECRET_KEY=…`,
 * `"password": "…"`, `password: two words`): only its name leaves. A quoted value goes whole; one not quoted, the rest of
 * its line, when the name is in a setting's shape (after a label in prose, only settings further on are cut).
 */
const SETTING = new RegExp(
  String.raw`\b(${NAME})(\\*["'${'`'}])?[ \t]*(?:=>|:=|[=:])[ \t]*(?:(${QUOTED})|([^\n]*))`,
  'g',
);
/** A setting whose value is on the lines under it, more indented (YAML's `password: |`, or the value on the next line). */
const BLOCK = new RegExp(
  String.raw`^([ \t]*)(${NAME})(\\*["'${'`'}])?[ \t]*:[ \t]*(?:[|>][-+0-9]*)?[ \t]*\n((?:\1[ \t]+[^\n]*(?:\n|$))+)`,
  'gm',
);
const ENV = new RegExp(String.raw`\b([A-Z][A-Z0-9_]{2,})=(?:${QUOTED}|\S+)`, 'g');
const blocks = (t) =>
  t.replace(BLOCK, (m, ind, name, quote, body) =>
    settingLike(name, quote) ? `${ind}${name}=[value]\n` : m.slice(0, m.length - body.length) + blocks(body),
  );
const values = (t) =>
  t.replace(SETTING, (m, name, quote, quoted, rest) =>
    quoted !== undefined || settingLike(name, quote)
      ? `${name}=[value]`
      : m.slice(0, m.length - rest.length) + values(rest),
  );
/** Every setting's value in a line's text cut to its name, before the text is put on one line. */
export const settings = (t) => values(blocks(t)).replace(ENV, '$1=[value]');

/** Each line of a JSONL record as an object; a line that isn't one is skipped and counted. */
export function entriesOf(text) {
  const out = [];
  let bad = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { entries: out, bad };
}

const chars = (s) => [...s].length;
const typed = (s) =>
  chars(s) > PASTE_MAX || FENCED.test(s) || TYPED_INDENT.test(s) || /`[^`]+`/.test(s)
    ? `[pasted, ${chars(s)} characters, left on the Mac]`
    : s;
/**
 * The agent's words with the code it quotes left on the Mac. A backtick left after that is code that didn't parse (a
 * span holding a fence, one not closed): then the whole of it stays on the Mac. Never cut here: render scrubs a line
 * whole, then cuts it to LINE_MAX, so a cut can't hide what makes a secret a secret.
 */
const words = (raw) => {
  // A first cut, far past what leaves (LINE_MAX), only to bound the work: what makes a secret within the first LINE_MAX
  // characters a secret is still there when render scrubs it.
  const s = [...raw].slice(0, SCRUB_MAX).join('');
  const out = s
    .replace(FENCE, (m) => `\n[code, ${chars(m)} characters, left on the Mac]\n`)
    .replace(INDENTED, (m) => `\n[code, ${chars(m)} characters, left on the Mac]\n`)
    .replace(INLINE, '[code]');
  return out.includes('`') ? `[code, ${chars(s)} characters, left on the Mac]` : out;
};
/** At most LINE_MAX whole characters. */
const cutLine = (s) => {
  const all = [...s];
  return all.length > LINE_MAX ? `${all.slice(0, LINE_MAX).join('')}…` : s;
};
const str = (x) => (typeof x === 'string' ? x : '');

/** The words of the agent's own question, plan or to-do tools: only these fields, only as text. */
function ownWords(name, input) {
  if (!input || typeof input !== 'object') return [];
  if (name === 'AskUserQuestion' && Array.isArray(input.questions))
    return input.questions.flatMap((q) => {
      const options = Array.isArray(q?.options) ? q.options.map((o) => str(o?.label)).filter(Boolean) : [];
      const w = str(q?.question);
      return w ? [{ kind: 'question', text: options.length ? `${w} (${options.join(' / ')})` : w }] : [];
    });
  if (name === 'ExitPlanMode' && str(input.plan)) return [{ kind: 'plan', text: str(input.plan) }];
  if (name === 'TodoWrite' && Array.isArray(input.todos))
    return input.todos
      .map((t) => ({ kind: 'todo', text: str(t?.content), done: t?.status === 'completed' }))
      .filter((t) => t.text);
  return [];
}

/** A typed turn's text, or null when any of it is Claude Code's own or Merle's. */
const typedText = (blocks) => {
  if (
    blocks.some(
      (t) => MACHINE.test(t) || MACHINE_ANYWHERE.test(t) || MERLE_NOTE.test(t) || CLAUDE_SAYS.test(t),
    )
  )
    return null;
  const t = blocks.join('\n');
  return t.trim() ? t : null;
};

/**
 * What may leave from these entries: lines of `you`, `agent`, `question`, `plan`, `todo` and `tool`, in order. Counts
 * what it dropped. `keep(entry)` says whether an entry may be read at all (written since reading was on, in a folder it
 * reads); one it says no to is dropped whole. `unknown` is true when turns of a kind it reads came in a shape it doesn't
 * know, and none of that kind was recognised: then nothing is sent.
 */
export function extract(entries, keep = () => true) {
  const lines = [];
  const tools = new Map();
  const failed = new Set();
  const seen = { user: 0, assistant: 0 };
  const read = { user: 0, assistant: 0 };
  let dropped = 0;
  for (const e of entries) {
    if (e.isSidechain === true || e.isCompactSummary === true || e.isApiErrorMessage === true || !keep(e)) {
      dropped++;
      continue;
    }
    if (e.type === 'user' || e.type === 'assistant') seen[e.type]++;
    const content = e.message && typeof e.message === 'object' ? e.message.content : undefined;
    if (
      e.type === 'user' &&
      e.message?.role === 'user' &&
      (typeof content === 'string' || Array.isArray(content))
    ) {
      read.user++;
      if (e.isMeta === true) {
        dropped++;
        continue;
      }
      if (typeof content === 'string') {
        const t = typedText([content]);
        if (t === null) dropped++;
        else lines.push({ kind: 'you', text: typed(t) });
        continue;
      }
      // A tool's result comes back as a user turn: only whether it failed is kept, never what it said.
      const results = content.filter((b) => b?.type === 'tool_result');
      for (const r of results)
        if (r.is_error === true && typeof r.tool_use_id === 'string') failed.add(r.tool_use_id);
      if (results.length || content.some((b) => b?.type !== 'text')) {
        dropped++;
        continue;
      }
      const t = typedText(content.filter((b) => typeof b?.text === 'string').map((b) => b.text));
      if (t === null) dropped++;
      else lines.push({ kind: 'you', text: typed(t) });
      continue;
    }
    if (e.type === 'assistant' && e.message?.role === 'assistant' && Array.isArray(content)) {
      read.assistant++;
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
          lines.push({ kind: 'agent', text: words(b.text) });
        else if (b?.type === 'tool_use') {
          const name = typeof b.name === 'string' && TOOL.test(b.name) ? b.name : 'a tool';
          const line = { kind: 'tool', text: name, error: false };
          if (typeof b.id === 'string') tools.set(b.id, line);
          lines.push(line);
          for (const w of ownWords(b.name, b.input)) lines.push({ ...w, text: words(w.text) });
        } else dropped++; // thinking, redacted thinking, images, anything new
      }
      continue;
    }
    dropped++;
  }
  for (const [id, line] of tools) if (failed.has(id)) line.error = true;
  const unknown = (seen.user > 0 && read.user === 0) || (seen.assistant > 0 && read.assistant === 0);
  return { lines: unknown ? [] : lines, dropped, unknown, known: !unknown && read.user + read.assistant > 0 };
}

const LABEL = { you: 'You', agent: 'Agent', question: 'Question', plan: 'Plan', todo: 'To-do', tool: 'Tool' };

/**
 * The extract as it leaves: each line scrubbed (placeholders without numbers, so nothing can be put back), anything that
 * looks like a setting with a value cut to its name, labelled, one per line, cut from the oldest end to `TURN_MAX`
 * bytes. Returns the text and how many lines were changed.
 */
export function render(lines, known = []) {
  const s = scrubber(known);
  let scrubbed = 0;
  const out = lines.map((l) => {
    const raw = l.text.replace(/\s+/g, ' ').trim();
    // Settings first, line by line, so a value not quoted takes the rest of its own line and no more.
    const set = settings(l.text);
    // Scrubbed whole, then cut: a cut first could take away what makes a secret recognisable.
    const clean = cutLine(s.plain(s.text(set.replace(/\s+/g, ' ').trim())));
    if (clean !== raw) scrubbed++;
    const tail = l.kind === 'tool' && l.error ? ' (failed)' : l.kind === 'todo' && l.done ? ' (done)' : '';
    return `${LABEL[l.kind]}: ${clean}${tail}`;
  });
  const kept = [];
  let bytes = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const n = Buffer.byteLength(out[i]) + 1;
    if (bytes + n > TURN_MAX) break;
    kept.unshift(out[i]);
    bytes += n;
  }
  return { text: kept.join('\n'), scrubbed, cut: out.length - kept.length };
}
