// The deploy line for /merle init, and the deploy commands the plugin's hook watches for. Plain JavaScript with no
// dependencies, so it runs in any team's repo. It reads the repo and plans; it writes only through writeDeploy, which
// the skill runs once the person has said yes.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

export const APP = 'https://app.hellomerle.com/v1/deploys';

/**
 * The line, the same as Merle's Settings and docs show (a test holds them together). The token comes from the
 * environment and never sits in a file. It can't fail the deploy it follows.
 */
export const LINE = (url = APP) =>
  `curl -fsS --max-time 10 ${url} -H "Authorization: Bearer $MERLE_DEPLOY_TOKEN" -d sha=$(git rev-parse HEAD) || echo "Merle didn’t hear about this deploy." >&2`;

/** A command that ships to a host. A guess from the words: the hook only reminds, and init only offers. */
export const DEPLOY_COMMAND = new RegExp(
  [
    String.raw`\bwrangler\b[^\n;&|]*\bdeploy\b`,
    String.raw`\b(?:fly|flyctl)\s+deploy\b`,
    String.raw`\bvercel\b[^\n;&|]*--prod\b`,
    String.raw`\bnetlify\s+deploy\b[^\n;&|]*--prod\b`,
    String.raw`\brailway\s+up\b`,
    String.raw`\bfirebase\s+deploy\b`,
    String.raw`\b(?:sst|serverless|sls|cdk|kamal|eb)\s+deploy\b`,
    String.raw`\bgcloud\s+(?:app|run|functions)\s+deploy\b`,
    String.raw`\bgit\s+push\s+(?:heroku|dokku)\b`,
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy\b`,
    String.raw`(?:^|[\s/])deploy\.sh\b`,
  ].join('|'),
  'i',
);
/** Not production: never followed by the line. */
/** Not production: a word for it in a name, a flag or an app's name, never a domain's `.dev`. */
const NOT_PRODUCTION = /(?:^|[\s=:_-])(?:preview|staging|dev|development|test)(?=$|[\s:,_-])/i;
export const isDeploy = (cmd) => DEPLOY_COMMAND.test(cmd) && !NOT_PRODUCTION.test(cmd);

/**
 * The command itself deploys, not one that only shows the words (`echo wrangler deploy`, `grep "fly deploy" README`): some
 * part of it, past env assignments and npx and the like, deploys and doesn't start with a command that only reads. For
 * the hook.
 */
export const runsDeploy = (cmd) =>
  cmd
    .replace(/"[^"]*"|'[^']*'/g, '""') // quoted words are an argument, never a command: a commit message names no deploy
    .split(/&&|\|\||;|\n/)
    .map((p) =>
      p
        .trim()
        .replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '')
        .replace(/^(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|sudo|time)\s+(?:--\S+\s+)*/, ''),
    )
    .some((p) => !/^(?:echo|grep|rg|cat|less|head|tail|printf|git\s+(?!push\b))/.test(p) && isDeploy(p));
/** Steps that deploy through a known action, in a workflow. */
const DEPLOY_ACTION =
  /uses:\s*(?:superfly\/flyctl-actions|cloudflare\/wrangler-action|railwayapp\/|w9jds\/firebase-action)/i;

const read = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const list = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** A host that already tells GitHub when production is deployed, which Merle hears through the GitHub App. */
function reporter(root) {
  if (existsSync(join(root, 'vercel.json')) || existsSync(join(root, '.vercel', 'project.json')))
    return {
      host: 'Vercel',
      source: existsSync(join(root, 'vercel.json')) ? 'vercel.json' : '.vercel/project.json',
    };
  if (existsSync(join(root, 'netlify.toml'))) return { host: 'Netlify', source: 'netlify.toml' };
  for (const f of workflows(root)) {
    const y = read(join(root, f)) ?? '';
    // A job's own environment, at the indent of its runs-on: never a deploy action's input that happens to share the name.
    for (const indent of new Set([...y.matchAll(/^( *)runs-on:/gm)].map((m) => m[1]))) {
      const job = new RegExp(
        `^${indent}environment:\\s*(?:\\n${indent} +name:\\s*)?['"]?(?:production|prod)\\b`,
        'im',
      );
      if (job.test(y)) return { host: 'a GitHub Actions environment', source: f };
    }
  }
  return null;
}

const workflows = (root) =>
  list(join(root, '.github', 'workflows'))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => `.github/workflows/${f}`);

const shellFiles = (root) => [
  ...list(root).filter((f) => /\.sh$/.test(f)),
  ...['scripts', 'bin'].flatMap((d) =>
    list(join(root, d))
      .filter((f) => /\.sh$|^deploy$/.test(f))
      .map((f) => `${d}/${f}`),
  ),
];

const packageFiles = (root) => [
  'package.json',
  ...['apps', 'packages'].flatMap((d) =>
    list(join(root, d))
      .map((p) => `${d}/${p}/package.json`)
      .filter((f) => existsSync(join(root, f))),
  ),
];

/** After the last deploy command in a shell script, at its indent; a command continued with \ ends where it ends. */
function inScript(root, file, url) {
  const src = read(join(root, file));
  if (src === null) return null;
  if (src.includes('/v1/deploys')) return { already: file };
  const lines = src.split('\n');
  let at = -1;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t && !t.startsWith('#') && runsDeploy(t)) at = i; // an echo that names a deploy isn't one
  });
  if (at < 0) return null;
  const after = lines[at].trim();
  let end = at;
  while (lines[end]?.trimEnd().endsWith('\\') && end < lines.length - 1) end++;
  // A deploy sent to the background hasn't finished when the next line runs: the person places the line.
  if (/(?:^|[^&])&\s*(?:#.*)?$/.test(lines[end])) return { manual: file };
  // On its own line, after the deploy and only when it worked. One form for every script: with set -e (inside, or
  // sh -e from outside) a failed deploy has already stopped it; without, $? says so and the line doesn't run.
  const indent = /^\s*/.exec(lines[at])?.[0] ?? '';
  lines.splice(end + 1, 0, `${indent}[ $? -eq 0 ] && (${QUIET}${LINE(url)})`);
  const content = lines.join('\n');
  // A deploy inside an if, a case or the background can't take the line as is: never write a script that won't parse.
  const shell = /bash/.test(lines[0] ?? '') ? 'bash' : 'sh';
  const parses = (text) => spawnSync(shell, ['-n'], { input: text }).status === 0;
  if (parses(src) && !parses(content)) return { manual: file };
  return { file, after, content };
}

/** A package script that deploys: the line after it, and only when it worked. */
function inPackage(root, file, url, covered) {
  const src = read(join(root, file));
  let pkg;
  try {
    pkg = JSON.parse(src ?? '');
  } catch {
    return [];
  }
  const out = [];
  // Every deploy script in this file, each change on top of the last: one file, one write.
  let content = src;
  const after = [];
  for (const [name, value] of Object.entries(pkg?.scripts ?? {})) {
    if (typeof value !== 'string' || NOT_PRODUCTION.test(name)) continue;
    // Part by part: `npm test && wrangler deploy` deploys to production; only the deploying part can say otherwise.
    const part = value.split(/&&|\|\||;/).find(isDeploy);
    if (NOT_PRODUCTION.test(part ?? value)) continue;
    if (!(/^deploy(?::prod(?:uction)?)?$/i.test(name) || part)) continue;
    if (value.includes('/v1/deploys')) {
      out.push({ already: `${file} (${name})` });
      continue;
    }
    // A script that runs a deploy script getting the line already: the line once is enough.
    if (covered.some((f) => value.includes(f))) continue;
    const next = `${value} && (${LINE(url)})`;
    const was = content;
    content = content.replace(JSON.stringify(value), () => JSON.stringify(next));
    if (content === was) continue; // written another way in the file: claim no change that wouldn't be written
    after.push(value);
  }
  if (after.length) out.push({ file, after: after.join(', '), content });
  return out;
}

/**
 * A step's own if:, ready to join with &&: its YAML quotes and a trailing comment gone, and ${{ }} unwrapped. null when
 * it can't be joined safely; undefined when there is none.
 */
function condition(raw) {
  if (raw === undefined) return undefined;
  let c = raw.replace(/\s+#.*$/, '').trim();
  const q = /^(["'])(.*)\1$/.exec(c);
  if (q) c = q[1] === "'" ? q[2].replace(/''/g, "'") : q[2];
  c = c.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();
  let depth = 0;
  for (const ch of c) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth < 0) return null;
  }
  return !c || depth || /^[|>]|["#\\]|\$\{\{/.test(c) ? null : c;
}

/** In a script, the line runs untraced (set -x would print the token into the log), and an unset token can't stop it (set -u). */
const QUIET = 'set +ux; ';

/** A step after the last step that deploys, with the token from the repo's secrets. It can't fail the job. */
function inWorkflow(root, file, url) {
  const src = read(join(root, file));
  if (src === null) return null;
  if (src.includes('/v1/deploys')) return { already: file };
  // A workflow pull requests start deploys previews, whatever its steps say.
  const on = /^on:\s*(.*(?:\n[ \t]+.*)*)/m.exec(src)?.[1] ?? '';
  // Only what the team itself starts deploys production: a workflow others can start (a pull request, a comment, another
  // workflow) and nothing the team starts gets no line.
  if (
    /pull_request|issue_comment|workflow_run/.test(on) &&
    !/\bpush\b|\brelease\b|workflow_dispatch/.test(on)
  )
    return null;
  const lines = src.split('\n');
  const steps = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)- /.exec(l);
    if (m) steps.push({ start: i, indent: m[1] });
  });
  let found = null;
  for (const s of steps) {
    let end = s.start + 1;
    while (end < lines.length) {
      const l = lines[end];
      const ind = /^\s*/.exec(l)?.[0].length ?? 0;
      if (l.trim() && ind <= s.indent.length) break;
      end++;
    }
    const block = lines.slice(s.start, end).join('\n');
    // Line by line: a run block that tests first, or an env that names development, still deploys on its deploy line.
    const command = lines
      .slice(s.start, end)
      .map((l) => l.replace(/^\s*(?:-\s*)?(?:run:\s*\|?)?\s*/, '').trim())
      .find((l) => l && !/^(?:name|if|with|env|id|uses):/.test(l) && isDeploy(l));
    const inputs = /^(\s*)with:\n((?:\1\s+.*\n?)*)/m.exec(block)?.[2] ?? ''; // only the lines under with:
    if (command || (DEPLOY_ACTION.test(block) && !NOT_PRODUCTION.test(inputs))) {
      const cmd = command ?? /uses:\s*(\S+)/.exec(block)?.[1] ?? 'the deploy step';
      // Its own condition, so the line runs only when the deploy did.
      const own = condition(/^\s*(?:-\s*)?if:\s*(.+)$/m.exec(block)?.[1]);
      // A condition that can't be carried over as is (over several lines, with quotes or a #): no change beats a
      // broken workflow, which would stop every deploy from it.
      found = own === null ? { manual: true } : { end, indent: s.indent, after: cmd, own };
    }
  }
  if (!found) return null;
  if (found.manual) return { manual: file };
  // The end of a step can be trailing blank lines: the new step goes before them.
  let at = found.end;
  while (at > 0 && !lines[at - 1].trim()) at--;
  const i = found.indent;
  lines.splice(
    at,
    0,
    `${i}- name: Tell Merle this commit is live`,
    // Only for what the team starts, and a push only to the default branch or a tag: any other run deploys a preview.
    `${i}  if: success() && ((github.event_name == 'push' && (github.ref == format('refs/heads/{0}', github.event.repository.default_branch) || startsWith(github.ref, 'refs/tags/'))) || github.event_name == 'release' || github.event_name == 'workflow_dispatch')${found.own ? ` && (${found.own})` : ''}`,
    `${i}  continue-on-error: true`,
    `${i}  env:`,
    `${i}    MERLE_DEPLOY_TOKEN: \${{ secrets.MERLE_DEPLOY_TOKEN }}`,
    `${i}  run: |`,
    `${i}    ${LINE(url)}`,
  );
  return { file, after: found.after, content: lines.join('\n') };
}

/** Every place this repo deploys from, each with its change, or a note that it tells Merle already. */
function planFound(root, url) {
  const scripts = [
    ...shellFiles(root).map((f) => inScript(root, f, url)),
    ...workflows(root).map((f) => inWorkflow(root, f, url)),
  ].filter(Boolean);
  // A script that already has the line, or is about to, covers the package script that runs it.
  const covered = scripts.flatMap((c) => c.file ?? c.already ?? []); // a script left to the person covers nothing
  return [...scripts, ...packageFiles(root).flatMap((f) => inPackage(root, f, url, covered))];
}

/**
 * Where this repo deploys, and the change that adds the line after it. Writes nothing. `reports`: a host that already
 * tells GitHub, so nothing is added. `notes`: what to tell the person, in plain words.
 */
export function deployPlan(root, o = {}) {
  const url = o.app ?? APP;
  const all = planFound(root, url);
  // Vercel and Netlify tell GitHub only about deploys their Git integration made: one from their command line doesn't.
  const cli = all.some((c) => /\b(?:vercel|netlify)\b/i.test(c.after ?? ''));
  const said = reporter(root);
  const reports = said && !(cli && /Vercel|Netlify/.test(said.host)) ? said : null;
  if (reports)
    return {
      reports,
      changes: [],
      notes: [
        `${reports.host} (${reports.source}) tells GitHub when a production deploy is done, and Merle hears it from GitHub. Nothing to add. If GitHub asks you to accept Merle's Deployments permission, accept it.`,
      ],
    };
  const changes = all.filter((c) => c.file && inRepo(root, c.file));
  const notes = [
    ...all.filter((c) => c.already).map((c) => `${c.already} already tells Merle when it deploys.`),
    ...all
      .filter((c) => c.manual)
      .map(
        (c) =>
          `${c.manual}: the line can't be added there safely, so nothing was changed. Put the deploy line right after the deploy finishes.`,
      ),
  ];
  if (!changes.length && !notes.length)
    notes.push(
      existsSync(join(root, 'fly.toml'))
        ? 'fly.toml: this app deploys with fly deploy, and no script or workflow in the repo runs it. Run the deploy line right after fly deploy, or put both in a script.'
        : 'No deploy command found in package.json, a deploy script or a workflow. Add the deploy line as the last step of your production deploy.',
    );
  return { reports: null, changes, notes };
}

/** A file that is really in this repo: a link out of it (to ~/.zshrc, say) is never planned or written. */
const inRepo = (root, file) => {
  try {
    return realpathSync(join(root, file)).startsWith(realpathSync(root) + sep);
  } catch {
    return false;
  }
};

/** Writes what the plan said: each changed file whole, and only inside the repo. */
export function writeDeploy(root, plan) {
  const files = plan.changes.filter((c) => inRepo(root, c.file));
  for (const c of files) writeFileSync(join(root, c.file), c.content);
  return files.map((c) => c.file);
}
