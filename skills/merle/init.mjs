#!/usr/bin/env node
// Merle's installer helper, for /merle init (SKILL.md next to this file). It runs in your own repo, so it is plain
// JavaScript with no dependencies (any Node 18+).
//
//   node init.mjs detect [dir]                          what the repo is: framework, layout, sign-in, GitHub, site, CSP
//   node init.mjs plan  --product <id> [--name <n>] [--endpoint <url>] [--full] [dir]   the smallest change, as JSON (nothing written)
//   node init.mjs write --product <id> [--name <n>] [--endpoint <url>] [--full] [dir]   writes that change
//
// The change is the feedback button: the two lines, the TypeScript declaration and any Content-Security-Policy.
// --full adds customers' names and merle.yml.
//
// Everything it says comes from a file in the repo, and says which. It never reads .env files (only *.example and
// *.sample), never writes a secret, and never edits a file it doesn't name in the plan.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the hosted feedback button lives. Only someone running their own Merle has another. */
import { deployPlan, LINE, writeDeploy } from './deploys.mjs';

const ENDPOINT = 'https://feedback.hellomerle.com';
const DOCS = 'https://hellomerle.com/docs';

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.svelte-kit',
  '.astro',
  '.output',
  '.vercel',
  '.wrangler',
  'coverage',
  '.turbo',
  'out',
]);

const read = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const json = (f) => {
  const t = read(f);
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};
const first = (dir, names) => names.map((n) => join(dir, n)).find((f) => existsSync(f)) ?? null;

/** Tests, fixtures and examples: never evidence of how the product itself works. */
const isTest = (f) =>
  /(^|\/)(tests?|e2e|__tests__|__mocks__|fixtures?|examples?|dev)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(
    f,
  );

/** The repo's files: what git tracks (so build output and ignored files never count), or a walk without git. */
function filesOf(dir, git) {
  if (git) {
    try {
      const out = execFileSync('git', ['-C', dir, 'ls-files', '-co', '--exclude-standard'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      });
      const list = out
        .split('\n')
        // A .env git doesn't ignore still holds secrets: never opened, only *.example and *.sample.
        .filter(
          (f) => f && !f.split('/').some((p) => SKIP.has(p) || /^\.env(?!.*\.(example|sample)$)/.test(p)),
        )
        .map((f) => join(dir, f))
        .filter((f) => {
          try {
            return statSync(f).size < 512 * 1024;
          } catch {
            return false;
          }
        });
      if (list.length) return list.slice(0, 20000);
    } catch {}
  }
  return walk(dir);
}

/** Files under dir, skipping build output and dependencies. */
function walk(dir, max = 4000) {
  const out = [];
  const go = (d, depth) => {
    if (depth > 7 || out.length >= max) return;
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (
        SKIP.has(n) ||
        n.startsWith('dist') ||
        (n.startsWith('.') && n !== '.env.example' && n !== '.firebaserc')
      )
        continue;
      const p = join(d, n);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) go(p, depth + 1);
      else if (s.size < 512 * 1024) out.push(p);
    }
  };
  go(dir, 0);
  return out;
}

const depsOf = (pkg) => ({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
const has = (deps, ...names) =>
  names.some((n) =>
    n.endsWith('*') ? Object.keys(deps).some((d) => d.startsWith(n.slice(0, -1))) : n in deps,
  );

/** The package directories: the root, and its workspaces (pnpm, npm, yarn; `dir/*` patterns). */
function packages(root) {
  const pkg = json(join(root, 'package.json'));
  const pnpm = read(join(root, 'pnpm-workspace.yaml'));
  const globs = [
    ...(Array.isArray(pkg?.workspaces) ? pkg.workspaces : (pkg?.workspaces?.packages ?? [])),
    ...(pnpm ? [...pnpm.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1]) : []),
  ];
  const dirs = [root];
  for (const g of globs) {
    if (g.startsWith('!')) continue;
    if (g.endsWith('/*') || g.endsWith('/**')) {
      const base = join(root, g.replace(/\/\*+$/, ''));
      try {
        for (const n of readdirSync(base).sort())
          if (existsSync(join(base, n, 'package.json'))) dirs.push(join(base, n));
      } catch {}
    } else if (existsSync(join(root, g, 'package.json'))) dirs.push(join(root, g));
  }
  return dirs.map((dir) => ({ dir, pkg: json(join(dir, 'package.json')) }));
}

function frameworkOf(dir, pkg) {
  const d = depsOf(pkg);
  if (has(d, 'next')) return 'nextjs';
  if (has(d, '@remix-run/react', '@remix-run/node', '@react-router/dev')) return 'remix';
  if (has(d, '@sveltejs/kit')) return 'sveltekit';
  if (has(d, 'astro')) return 'astro';
  if (has(d, 'vite') && has(d, 'react', 'preact', 'react-dom')) return 'vite-react';
  if (first(dir, ['index.html', 'public/index.html'])) return 'html';
  return null;
}

const SERVER_DEPS = ['hono', 'express', 'fastify', 'koa', '@hapi/hapi', 'h3', 'elysia'];

/** Where the page shell is: the one file every page renders inside, as each framework names it. */
function layoutsOf(dir, framework, files) {
  const at = (names) => {
    const f = first(dir, names);
    return f ? [f] : [];
  };
  const ext = (b) => ['tsx', 'jsx', 'js', 'ts'].map((e) => `${b}.${e}`);
  switch (framework) {
    case 'nextjs': {
      const app = at([...ext('app/layout'), ...ext('src/app/layout')]);
      if (app.length) return { router: 'app', files: app };
      const doc = at([...ext('pages/_document'), ...ext('src/pages/_document')]);
      if (doc.length) return { router: 'pages', files: doc };
      return { router: 'pages', files: at([...ext('pages/_app'), ...ext('src/pages/_app')]) };
    }
    case 'remix':
      return { files: at([...ext('app/root')]) };
    case 'sveltekit':
      return { files: at(['src/app.html']) };
    case 'vite-react':
      return { files: at(['index.html']) };
    case 'astro': {
      // The .astro file with </body> that the most other files import: the shell pages share.
      const shells = files.filter((f) => f.endsWith('.astro') && /<\/body>/i.test(read(f) ?? ''));
      const sources = files.filter((f) => /\.(astro|ts|tsx|js|mdx?)$/.test(f));
      const uses = (f) =>
        sources.filter(
          (s) =>
            s !== f &&
            new RegExp(`from\\s+['"][^'"]*/${basename(f).replace('.', '\\.')}['"]`).test(read(s) ?? ''),
        ).length;
      // Every shell something renders, and every page with its own <body>: each needs the feedback button once.
      return {
        files: shells
          .filter((f) => /\/src\/pages\//.test(f) || uses(f) > 0)
          .sort((a, b) => uses(b) - uses(a)),
      };
    }
    case 'html':
      return { files: files.filter((f) => f.endsWith('.html') && /<\/body>/i.test(read(f) ?? '')) };
  }
  return { files: [] };
}

/** What a new project's template calls itself: nobody's product. */
const STARTER = /^(vite(-project)?( \+ [\w+ .-]+)?|create next app|react app|next\.?js app)$/i;

/** The product's name, from the page's own title. Never guessed from a package name. */
function nameOf(layouts, pkg) {
  for (const f of layouts) {
    const t = read(f) ?? '';
    const m =
      /<title>([^<{}]+)<\/title>/i.exec(t) ??
      /metadata[^=]*=\s*{[\s\S]*?title:\s*(?:{\s*default:\s*)?['"`]([^'"`]+)['"`]/.exec(t);
    const title = m?.[1].trim();
    if (title && title !== pkg?.name && !STARTER.test(title)) return { value: title, source: f };
  }
  return null;
}

/** Only example env files: real ones hold secrets. */
const envExamples = (dirs) =>
  [...new Set(dirs)].flatMap((d) =>
    ['.env.example', '.env.local.example', '.env.sample', 'env.example']
      .map((n) => join(d, n))
      .filter((f) => existsSync(f)),
  );

function authOf(root, pkgs, files, examples) {
  const all = pkgs.map((p) => ({ ...p, deps: depsOf(p.pkg) }));
  const by = (...names) => all.find((p) => has(p.deps, ...names));
  const envText = examples.map((f) => read(f) ?? '').join('\n');
  const src = (re) => files.find((f) => /\.(m?[jt]sx?|astro|svelte|json)$/.test(f) && re.test(read(f) ?? ''));
  const envVal = (re) =>
    re
      .exec(envText)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '') || null;
  const where = (p) =>
    `${relative(root, join(p.dir, 'package.json'))} (${Object.keys(p.deps).find((d) => /clerk|supabase|auth0|firebase/.test(d))})`;

  let p = by('@clerk/*');
  if (p) {
    // A publishable key is public by design: pk_test_<base64 of "<frontend api>$">.
    const pk = envVal(/CLERK_PUBLISHABLE_KEY\s*=\s*(pk_(?:test|live)_[A-Za-z0-9+/=_-]+)/) ?? null;
    let issuer = null;
    if (pk) {
      try {
        const host = Buffer.from(pk.replace(/^pk_(test|live)_/, ''), 'base64')
          .toString('utf8')
          .replace(/\$$/, '');
        if (/^[\w.-]+$/.test(host))
          issuer = { value: `https://${host}`, source: 'the Clerk publishable key in .env.example' };
      } catch {}
    }
    return { provider: 'clerk', source: where(p), issuer, audience: null };
  }
  p = by('@supabase/supabase-js', '@supabase/ssr', '@supabase/auth-helpers-nextjs');
  if (p) {
    const url = envVal(/SUPABASE_URL\s*=\s*(https:\/\/[\w-]+\.supabase\.co)/);
    return {
      provider: 'supabase',
      source: where(p),
      issuer: url ? { value: `${url}/auth/v1`, source: 'SUPABASE_URL in .env.example' } : null,
      audience: { value: 'authenticated', source: 'Supabase’s own audience' },
    };
  }
  p = by('@auth0/*');
  if (p) {
    const dom = envVal(/AUTH0_(?:ISSUER_BASE_URL|DOMAIN)\s*=\s*(?:https:\/\/)?([\w.-]+\.auth0\.com)/);
    const aud = envVal(/AUTH0_AUDIENCE\s*=\s*(\S+)/);
    return {
      provider: 'auth0',
      source: where(p),
      issuer: dom ? { value: `https://${dom}/`, source: 'AUTH0_DOMAIN in .env.example' } : null,
      audience: aud ? { value: aud, source: 'AUTH0_AUDIENCE in .env.example' } : null,
    };
  }
  p = by('firebase', 'firebase-admin', 'reactfire');
  if (p) {
    const rc = json(join(root, '.firebaserc'));
    const f = rc?.projects?.default ? null : src(/projectId:\s*['"]([\w-]+)['"]/);
    const project =
      rc?.projects?.default ?? (f ? /projectId:\s*['"]([\w-]+)['"]/.exec(read(f) ?? '')?.[1] : null);
    const from = rc?.projects?.default ? '.firebaserc' : f ? relative(root, f) : null;
    return {
      provider: 'firebase',
      source: where(p),
      issuer: project ? { value: `https://securetoken.google.com/${project}`, source: from } : null,
      audience: project ? { value: project, source: from } : null,
    };
  }
  // A sign-in of their own: a session library, or server code that sets a session cookie.
  const lib = all.find((x) =>
    has(
      x.deps,
      'next-auth',
      '@auth/core',
      'better-auth',
      'lucia',
      'iron-session',
      'express-session',
      'cookie-session',
      'passport',
      '@fastify/session',
      '@fastify/secure-session',
    ),
  );
  if (lib)
    return {
      provider: 'custom',
      source: `${relative(root, join(lib.dir, 'package.json'))} (a session library)`,
    };
  const f = files.find(
    (x) =>
      /\.(m?[jt]s)$/.test(x) &&
      /session/i.test(read(x) ?? '') &&
      /set-?cookie|setCookie|cookies\(\)\.set|\.cookie\(/i.test(read(x) ?? ''),
  );
  if (f) return { provider: 'custom', source: `${relative(root, f)} (sets a session cookie)` };
  return { provider: 'none', source: 'no sign-in found' };
}

/** Where the server code that knows the signed-in customer lives, for the signing function. */
function serverOf(root, app, pkgs, files) {
  const ts = (d) => existsSync(join(d, 'tsconfig.json')) || existsSync(join(root, 'tsconfig.json'));
  const src = (d) => (existsSync(join(d, 'src')) ? 'src/' : '');
  const mk = (kind, dir, file) => ({
    kind,
    dir: relative(root, dir) || '.',
    file: relative(root, join(dir, file)),
  });
  const e = (d) => (ts(d) ? 'ts' : 'js');
  switch (app.framework) {
    case 'nextjs':
      return mk('nextjs', app.abs, `${src(app.abs)}lib/merle.${e(app.abs)}`);
    case 'remix':
      return mk('remix', app.abs, `app/merle.server.${e(app.abs)}`);
    case 'sveltekit':
      return mk('sveltekit', app.abs, `src/lib/server/merle.${e(app.abs)}`);
  }
  // A server package of its own (a monorepo's API), or a server inside the app's package.
  const api =
    pkgs.find((p) => p.dir !== app.abs && has(depsOf(p.pkg), ...SERVER_DEPS)) ??
    pkgs.find((p) => has(depsOf(p.pkg), ...SERVER_DEPS));
  if (api) {
    const kind = SERVER_DEPS.find((d) => d in depsOf(api.pkg));
    const entries = files.filter(
      (f) =>
        f.startsWith(api.dir) &&
        /\.(m?[jt]s)$/.test(f) &&
        new RegExp(`from\\s+['"]${kind}['"]|require\\(['"]${kind}['"]\\)`).test(read(f) ?? ''),
    );
    const entry =
      entries.find((f) => /^(index|app|server|main)\.[cm]?[jt]s$/.test(basename(f))) ?? entries[0];
    const dir = entry ? dirname(entry) : join(api.dir, src(api.dir));
    const isTs = entry ? /\.ts$/.test(entry) : ts(api.dir);
    const cjs = !isTs && api.pkg?.type !== 'module' && !(entry ?? '').endsWith('.mjs');
    return {
      ...mk(kind, dir, `merle.${isTs ? 'ts' : cjs ? 'cjs' : 'js'}`),
      entry: entry ? relative(root, entry) : null,
    };
  }
  return null;
}

function githubOf(root, pkg, git) {
  if (git) {
    try {
      const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
      if (m) return { repo: m[1], source: 'git remote origin' };
    } catch {}
  }
  const r = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  const m =
    r &&
    (/^github:([\w.-]+\/[\w.-]+)$/.exec(r) ??
      /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(r) ??
      /^([\w.-]+\/[\w.-]+)$/.exec(r));
  return m ? { repo: m[1], source: 'package.json repository' } : null;
}

/** Where the product is live, from deploy files and site settings, each with where it was found. */
function sitesOf(root, files) {
  const out = [];
  const add = (url, f) => {
    try {
      const o = new URL(url).origin;
      if (
        o.startsWith('https://') &&
        !/localhost|127\.0\.0\.1|example\.(com|org)$/.test(o) &&
        !out.some((s) => s.url === o)
      )
        out.push({ url: o, source: relative(root, f) });
    } catch {}
  };
  for (const f of files) {
    const n = basename(f);
    const t = read(f) ?? '';
    if (n === 'fly.toml') {
      const app = /^app\s*=\s*['"]([\w-]+)['"]/m.exec(t)?.[1];
      if (app) add(`https://${app}.fly.dev`, f);
    } else if (/^wrangler\.(toml|jsonc?)$/.test(n)) {
      for (const m of t.matchAll(
        /(?:pattern|route)["']?\s*[:=]\s*["']([\w.-]+\.[a-z]{2,})(?:\/[^"']*)?["']/g,
      ))
        add(`https://${m[1]}`, f);
      for (const m of t.matchAll(
        /custom_domain["']?\s*[:=]\s*true[\s\S]{0,80}?["']([\w.-]+\.[a-z]{2,})["']/g,
      ))
        add(`https://${m[1]}`, f);
    } else if (n === 'CNAME' && /^[\w.-]+\.[a-z]{2,}\s*$/.test(t)) add(`https://${t.trim()}`, f);
    else if (/^astro\.config\.(mjs|ts|js)$/.test(n)) {
      const m = /\bsite:\s*['"](https:\/\/[^'"]+)['"]/.exec(t);
      if (m) add(m[1], f);
    } else if (n === 'package.json' || /\.env\.(example|sample)$/.test(n) || n === '.env.example') {
      for (const m of t.matchAll(
        /(?:SITE_URL|APP_URL|PUBLIC_URL|BASE_URL|"homepage")["']?\s*[=:]\s*["']?(https:\/\/[\w.-]+\.[a-z]{2,})/g,
      ))
        add(m[1], f);
    }
  }
  const platform = (u) => /\.(fly\.dev|workers\.dev|pages\.dev|vercel\.app|netlify\.app)$/.test(u);
  return out.sort((a, b) => Number(platform(a.url)) - Number(platform(b.url)));
}

/** Where a Content-Security-Policy is set, so the feedback button's address can be allowed in it. */
function cspOf(root, files) {
  const out = [];
  for (const f of files) {
    const t = read(f) ?? '';
    const n = basename(f);
    if (n === '_headers' && /Content-Security-Policy:/i.test(t))
      out.push({ file: relative(root, f), kind: 'headers' });
    else if (
      /\.(html|astro|svelte)$|^_document\./.test(n) &&
      /http-equiv=["']Content-Security-Policy/i.test(t)
    )
      out.push({ file: relative(root, f), kind: 'meta' });
    else if (
      /\.(m?[jt]sx?|json|toml)$/.test(n) &&
      /Content-Security-Policy|contentSecurityPolicy|helmet\(|\bcsp\s*:|insertScriptResource/.test(t)
    )
      out.push({ file: relative(root, f), kind: 'code' });
  }
  return out;
}

export function detect(root, { git = true } = {}) {
  const pkgs = packages(root);
  const files = filesOf(root, git);
  const code = files.filter((f) => !isTest(relative(root, f)));
  const apps = pkgs.map((p) => ({ ...p, framework: frameworkOf(p.dir, p.pkg) })).filter((p) => p.framework);
  if (!apps.length && first(root, ['index.html', 'public/index.html']))
    apps.push({ dir: root, pkg: null, framework: 'html' });
  // A web app in a workspace wins over a root that only holds tooling; among several, the one named like a site.
  const rank = (a) =>
    (a.dir === root && pkgs.length > 1 ? 1 : 0) +
    (/(^|\/)(web|site|app|www|frontend|client)$/.test(a.dir) ? -2 : 0);
  const chosen = [...apps].sort((a, b) => rank(a) - rank(b))[0];
  const appFiles = chosen
    ? code.filter(
        (f) => f.startsWith(chosen.dir + (chosen.dir.endsWith('/') ? '' : '/')) || chosen.dir === root,
      )
    : [];
  const app = chosen
    ? (() => {
        const l = layoutsOf(chosen.dir, chosen.framework, appFiles);
        return {
          abs: chosen.dir,
          dir: relative(root, chosen.dir) || '.',
          framework: chosen.framework,
          ...(l.router ? { router: l.router } : {}),
          layouts: l.files.map((f) => relative(root, f)),
          name: nameOf(l.files, chosen.pkg),
        };
      })()
    : null;
  if (app?.name) app.name.source = relative(root, app.name.source);
  const examples = envExamples([root, ...pkgs.map((p) => p.dir)]);
  const auth = authOf(root, pkgs, code, examples);
  const server = app && auth.provider === 'custom' ? serverOf(root, app, pkgs, code) : null;
  const deploy = files.map((f) => basename(f));
  const out = {
    app: app ? { ...app, abs: undefined } : null,
    alternatives: apps
      .filter((a) => a !== chosen)
      .map((a) => ({ dir: relative(root, a.dir) || '.', framework: a.framework })),
    auth,
    server,
    github: githubOf(root, json(join(root, 'package.json')), git),
    sites: sitesOf(root, code),
    csp: cspOf(root, code),
    envExample: examples[0] ? relative(root, examples[0]) : null,
    typescript:
      existsSync(join(root, 'tsconfig.json')) || (app ? existsSync(join(app.abs, 'tsconfig.json')) : false),
    secretsHome: deploy.includes('fly.toml')
      ? 'fly'
      : deploy.some((n) => /^wrangler\.(toml|jsonc?)$/.test(n))
        ? 'cloudflare'
        : deploy.includes('vercel.json') || app?.framework === 'nextjs'
          ? 'vercel'
          : deploy.includes('netlify.toml')
            ? 'netlify'
            : 'server',
  };
  delete out.app?.abs;
  return out;
}

// ---- plan: the smallest change ------------------------------------------------------------------------------

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The two lines, as the layout's own language writes them. */
function boxLines(kind, o) {
  const a = [
    `product="${attr(o.product)}"`,
    `endpoint="${attr(o.endpoint)}"`,
    ...(o.name ? [`name="${attr(o.name)}"`] : []),
  ].join(' ');
  const src = `${o.endpoint}/button.js`;
  if (kind === 'jsx') return [`<script type="module" src="${src}" async />`, `<merle-feedback ${a} />`];
  if (kind === 'astro')
    return [
      `<script is:inline type="module" src="${src}"></script>`,
      `<merle-feedback ${a}></merle-feedback>`,
    ];
  return [`<script type="module" src="${src}"></script>`, `<merle-feedback ${a}></merle-feedback>`];
}

/** Puts lines just before </body>, at the body's indent. */
export function beforeBody(src, lines) {
  const i = src.search(/<\/body>(?![\s\S]*<\/body>)/i);
  if (i < 0) return null;
  const start = src.lastIndexOf('\n', i) + 1;
  const indent = /^[ \t]*/.exec(src.slice(start))[0];
  const own = src.slice(start, i).trim() === '';
  const block = lines.map((l) => `${indent}  ${l}`).join('\n');
  return own
    ? `${src.slice(0, start)}${block}\n${src.slice(start)}`
    : `${src.slice(0, i)}\n${block}\n${indent}${src.slice(i)}`;
}

/** Adds what the feedback button needs to the directives a policy names, or works out from its default-src. */
export function allowHost(policy, host) {
  const parts = policy
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const named = (d) => parts.findIndex((p) => p.split(/\s+/)[0] === d);
  const def = named('default-src');
  const child = named('child-src');
  const sources = (i) =>
    parts[i]
      .split(/\s+/)
      .slice(1)
      .filter((s) => s !== "'none'");
  let changed = false;
  for (const [d, source] of [
    ['script-src', host],
    ['connect-src', host],
    ['frame-src', host],
    ['img-src', 'data:'],
    ['media-src', 'blob:'],
  ]) {
    const i = named(d);
    if (i >= 0 && parts[i].split(/\s+/).includes(source)) continue;
    // A directive missing from the policy follows default-src, and frame-src follows child-src first.
    const from = d === 'frame-src' && child >= 0 ? child : def;
    if (i >= 0) parts[i] = `${parts[i]} ${source}`;
    else if (from >= 0) parts.push([d, ...sources(from), source].join(' '));
    else continue;
    changed = true;
  }
  return changed ? parts.join('; ') : policy;
}

const SIGNER = {
  esm: (
    ts,
  ) => `// Merle: who the signed-in customer is, for <merle-feedback user="…">. Server only: the secret never reaches
// the browser. Set MERLE_IDENTITY_SECRET where your other server secrets live (Merle gives you the value).
// The token is base64url(payload).base64url(HMAC-SHA256(secret, payload)); it lasts an hour, so sign one per page.
import { createHmac } from 'node:crypto';

export function merleUser(u${ts ? ': { id: string; name?: string; email?: string; company?: string; plan?: string }' : ''})${ts ? ': string | undefined' : ''} {
  const secret = process.env.MERLE_IDENTITY_SECRET;
  if (!secret) return undefined; // not set yet: the feedback button still works, without Your messages
  const payload = Buffer.from(JSON.stringify({ ...u, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return \`\${payload}.\${createHmac('sha256', secret).update(payload).digest('base64url')}\`;
}
`,
  cjs: () => `// Merle: who the signed-in customer is, for <merle-feedback user="…">. Server only: the secret never reaches
// the browser. Set MERLE_IDENTITY_SECRET where your other server secrets live (Merle gives you the value).
// The token is base64url(payload).base64url(HMAC-SHA256(secret, payload)); it lasts an hour, so sign one per page.
const { createHmac } = require('node:crypto');

function merleUser(u) {
  const secret = process.env.MERLE_IDENTITY_SECRET;
  if (!secret) return undefined; // not set yet: the feedback button still works, without Your messages
  const payload = Buffer.from(JSON.stringify({ ...u, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return \`\${payload}.\${createHmac('sha256', secret).update(payload).digest('base64url')}\`;
}
module.exports = { merleUser };
`,
};

const JSX_TYPES = `// Merle's feedback button, <merle-feedback>, is a custom element: this tells TypeScript its attributes.
import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'merle-feedback': HTMLAttributes<HTMLElement> & {
        product: string;
        endpoint?: string;
        name?: string;
        privacy?: string;
        user?: string;
        'reply-time'?: string;
        'bottom-offset'?: string;
      };
    }
  }
}
`;

const SECRET_HOME = {
  fly: 'In Fly: run `fly secrets import`, paste `MERLE_IDENTITY_SECRET=<the value>`, then press Ctrl-D (it stays out of your shell history).',
  cloudflare:
    'In Cloudflare: `npx wrangler secret put MERLE_IDENTITY_SECRET`, and paste the value at the prompt.',
  vercel:
    'In Vercel: Project → Settings → Environment Variables, add MERLE_IDENTITY_SECRET for Production and Preview.',
  netlify: 'In Netlify: Site configuration → Environment variables, add MERLE_IDENTITY_SECRET.',
  server: 'Where your server reads its other secrets (its environment), as MERLE_IDENTITY_SECRET.',
};

const PROVIDER_NAME = { clerk: 'Clerk', supabase: 'Supabase', auth0: 'Auth0', firebase: 'Firebase' };

export function plan(root, d, o) {
  const changes = [];
  const todos = [];
  const secrets = [];
  /** A file as this plan leaves it so far: two changes to one file (a layout with its own CSP) build on each other. */
  const now = (file) => changes.find((c) => c.file === file)?.content ?? read(join(root, file));
  const edit = (file, content, why) => {
    const was = changes.find((c) => c.file === file);
    if (was) {
      was.content = content;
      was.why = `${was.why} ${why}`;
      return;
    }
    const before = read(join(root, file));
    if (before !== content) changes.push({ file, action: before === null ? 'create' : 'edit', why, content });
  };
  const name = o.name ?? d.app?.name?.value;
  const host = new URL(o.endpoint).origin;

  // 1. The feedback button, once, in the page shell.
  if (!d.app)
    todos.push(
      `No web app found. Ask where the page shell is, then add the two lines from ${DOCS}#button before </body>.`,
    );
  for (const file of d.app?.layouts ?? []) {
    const src = now(file) ?? '';
    if (src.includes('<merle-feedback')) continue; // already there
    const kind =
      /\.(tsx|jsx)$/.test(file) || (/\.(js|ts)$/.test(file) && d.app.framework !== 'html')
        ? 'jsx'
        : file.endsWith('.astro')
          ? 'astro'
          : 'html';
    const next = beforeBody(src, boxLines(kind, { ...o, name }));
    if (next) edit(file, next, 'Loads the feedback button and places it once, before </body>.');
    else
      todos.push(
        `${file} has no </body>: put <merle-feedback> where the app's root component renders (see ${DOCS}#button).`,
      );
  }
  if (d.app && !d.app.layouts.length)
    todos.push(
      `Found ${d.app.framework} in ${d.app.dir}, but not its page shell. Ask which file every page renders inside.`,
    );
  if (d.typescript && d.app && /tsx|jsx/.test((d.app.layouts ?? []).join(' '))) {
    edit(
      join(d.app.dir === '.' ? '' : d.app.dir, 'merle-feedback.d.ts'),
      JSX_TYPES,
      'Tells TypeScript the attributes of <merle-feedback>.',
    );
  }

  // 2. Content-Security-Policy: let the feedback button load and send, show a picture and play a recording.
  for (const c of d.csp) {
    const src = now(c.file) ?? '';
    if (c.kind === 'headers') {
      const next = src.replace(/(Content-Security-Policy:\s*)(.+)/gi, (_, k, v) => k + allowHost(v, host));
      if (next !== src) edit(c.file, next, `Lets the feedback button load from and send to ${host}.`);
    } else if (c.kind === 'meta') {
      const next = src.replace(
        /(http-equiv=["']Content-Security-Policy["'][^>]*?content=)(["'])(.*?)\2/gi,
        (_, k, q, v) => k + q + allowHost(v, host) + q,
      );
      if (next !== src) edit(c.file, next, `Lets the feedback button load from and send to ${host}.`);
    } else if (!src.includes(host))
      todos.push(
        `${c.file} sets a Content-Security-Policy in code: add ${host} to script-src, connect-src and frame-src there, data: to img-src and blob: to media-src, the way it adds its other sources.`,
      );
  }

  if (!name) todos.push('Ask for the product’s name as customers know it, then run this again with --name.');
  if (!o.full) return { changes, todos, secrets, pr: prOf(d, o, changes, secrets, name) };

  // 3. Who the customer is.
  const a = d.auth;
  let identity = null;
  if (a.provider === 'custom') {
    identity = { provider: 'custom' };
    const s = d.server;
    if (s) {
      edit(
        s.file,
        SIGNER[s.file.endsWith('.cjs') ? 'cjs' : 'esm'](s.file.endsWith('.ts')),
        'Signs the signed-in customer for the feedback button, on the server.',
      );
      secrets.push({ name: 'MERLE_IDENTITY_SECRET', where: SECRET_HOME[d.secretsHome] });
      const inPage = ['nextjs', 'remix', 'sveltekit'].includes(s.kind);
      todos.push(
        inPage
          ? `Wire the customer: where ${d.app?.layouts[0] ?? 'the layout'} (or its loader) knows who is signed in, pass user={merleUser({ id, name, email })} to <merle-feedback>. Signed out: leave user off.`
          : `Wire the customer: add a route to the server near ${s.entry ?? s.file} that answers the signed-in customer's merleUser({ id, name, email }) as text (401 when signed out), and on the page set it once it's there: document.querySelector('merle-feedback')?.setAttribute('user', token).`,
      );
      if (d.envExample) {
        const env = read(join(root, d.envExample)) ?? '';
        if (!env.includes('MERLE_IDENTITY_SECRET'))
          edit(
            d.envExample,
            `${env.replace(/\n?$/, '\n')}# Merle: signs customers for the feedback button. The value comes from Merle; never commit it.\nMERLE_IDENTITY_SECRET=\n`,
            'Names the one secret to set (no value).',
          );
      }
    } else
      todos.push(
        `A sign-in of your own was found, but not the server code: ask where the server knows who is signed in, and add the function from ${DOCS}#customers there.`,
      );
  } else if (a.provider !== 'none') {
    const P = PROVIDER_NAME[a.provider];
    identity = {
      provider: a.provider,
      ...(a.issuer ? { issuer: a.issuer.value } : {}),
      ...(a.provider === 'clerk' ? { audience: 'merle' } : a.audience ? { audience: a.audience.value } : {}),
    };
    if (!a.issuer)
      todos.push(
        `Ask for the ${P} issuer (${DOCS}#customers has where to find it) and put it in merle.yml under identity.`,
      );
    if (a.provider !== 'clerk' && !a.audience)
      todos.push(`Ask for the ${P} audience and put it in merle.yml under identity.`);
    const how = {
      clerk:
        "In Clerk, add a JWT template named merle with aud set to merle. On the page: user={await getToken({ template: 'merle' })}.",
      supabase:
        'Supabase must sign with asymmetric keys (Project Settings → JWT Keys). On the page: user={session.access_token}.',
      auth0: 'On the page: user={accessToken} for your API (the audience above).',
      firebase: 'On the page: user={await auth.currentUser?.getIdToken()}.',
    }[a.provider];
    todos.push(
      `Wire the customer: pass the ${P} token to <merle-feedback user="…"> where the page knows the session. ${how}`,
    );
  }

  // 4. merle.yml: only what Merle can't find on its own, each line saying where it came from.
  const gh = d.github;
  const y = [
    '# Merle reads this from your default branch. Only what it can’t find on its own; the back office',
    `# shows each setting as "from merle.yml". ${DOCS}#merle-yml`,
    `product: ${o.product}`,
    ...(name
      ? [`name: ${JSON.stringify(name)}${d.app?.name && !o.name ? `  # from ${d.app.name.source}` : ''}`]
      : []),
    ...(gh
      ? [
          '# bugs: you  # you to see bugs first, github to file them straight. Anyone can send a message, so choose.',
          `repo: ${gh.repo}  # from ${gh.source}`,
        ]
      : ['# bugs come to you in the back office: no GitHub repo was found']),
    '# reply-time: Usually within a day  # shown to customers after they send',
    '# masks: [.account-email]  # more to blur in pictures and recordings (not applied yet); form fields always are',
    ...(gh ? ['# linear: { team: ENG }  # file issues in Linear instead'] : []),
    ...(identity
      ? [
          'identity:',
          `  provider: ${identity.provider}  # from ${a.source}`,
          ...(identity.issuer ? [`  issuer: ${identity.issuer}  # from ${a.issuer.source}`] : []),
          ...(identity.audience
            ? [
                `  audience: ${identity.audience}${a.audience ? `  # ${a.audience.source}` : '  # the JWT template’s aud'}`,
              ]
            : []),
        ]
      : ['# identity: none found, so customers are anonymous. Add it when they sign in.']),
  ];
  edit('merle.yml', `${y.join('\n')}\n`, 'What Merle can’t find on its own.');

  if (!d.sites.length)
    todos.push('Ask where the product is live (https://…): Merle takes messages only from there.');
  return { changes, todos, secrets, pr: prOf(d, o, changes, secrets, name) };
}

function prOf(d, o, changes, secrets, name) {
  const app = name ?? 'the app';
  const lines = [
    `Adds Merle's feedback button to ${app}, so customers can say what's wrong inside it and hear back when it's fixed.`,
    '',
    '### What changed',
    ...changes.map((c) => `- \`${c.file}\`: ${c.why}`),
    '',
    '### What the feedback button sends to Merle',
    '- What the customer writes, and the page they were on.',
    '- What they tapped before: button labels, page changes, and each request’s method, path and status. Never what they typed into the app (only its length), never request bodies.',
    '- The screen size.',
    '- Error messages the page itself raised, as the app wrote them.',
    '- A picture or their voice, only when they tap for it. Every form field is blurred before the picture is taken.',
    ...(d.auth.provider !== 'none'
      ? [
          '- For a signed-in customer: their id, and name or email if the server includes them. Signed by the server, never taken from the browser.',
        ]
      : []),
    '',
    '### What to set',
    ...(secrets.length
      ? secrets.map((s) => `- \`${s.name}\`: ${s.where} It is not in this pull request.`)
      : ['- Nothing: no secret is needed.']),
    '',
    "### Merle's side",
    `- Product \`${o.product}\`, taking messages from: ${d.sites.length ? d.sites.map((s) => `${s.url} (from \`${s.source}\`)`).join(', ') : 'the live address (not found in the repo)'}.`,
    `- The feedback button loads from ${o.endpoint}.`,
    '',
    '### Check it',
    `After deploying, \`/merle doctor ${d.sites[0]?.url ?? 'https://<your site>'}\` checks it end to end and files nothing.`,
  ];
  return { title: `Add Merle's feedback button${name ? ` to ${name}` : ''}`, body: lines.join('\n') };
}

export function write(root, p) {
  for (const c of p.changes) {
    mkdirSync(dirname(join(root, c.file)), { recursive: true });
    writeFileSync(join(root, c.file), c.content);
  }
  return p.changes.map((c) => c.file);
}

// ---- Commit ---------------------------------------------------------------------------------------------------
// The skill may run git only in exact forms (SKILL.md's allowed-tools): `git add *` would take `-A` or `.`, and
// `git commit *` would take `--amend` or `-a`. So the commit is made here, from the files the agent names, each checked.

/** Merle's own branches, the ones SKILL.md switches to: /merle commits on these and nowhere else. */
const BRANCH = /^merle-(feedback-button|deploy-line|customer-names)(-2)?$/;
const git = (root, ...args) =>
  execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const messageAt = (root) => join(git(root, 'rev-parse', '--absolute-git-dir'), 'MERLE_COMMIT_MSG');

/** The message for the commit after this write, kept in the repo's own .git and used once (`commit`). */
export function keepMessage(root, title, body) {
  try {
    writeFileSync(messageAt(root), `${title}\n\n${body}\n`);
  } catch {
    // Not a git repo: there's nothing to commit later.
  }
}

/**
 * Commits exactly the files named, with the message the last write kept, on Merle's own branch. Each must be a changed
 * regular file inside the repo: not a link, not ignored, not in .git, and not a .env file (*.example and *.sample are
 * fine). Anything else refuses the whole commit, with nothing staged. Answers what it committed, or why not.
 */
export function commitFiles(cwd, files) {
  const here = realpathSync(cwd);
  const root = realpathSync(git(here, 'rev-parse', '--show-toplevel'));
  let branch = '';
  try {
    branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  } catch {}
  if (!BRANCH.test(branch))
    return `Commit on a branch /merle made (merle-feedback-button, merle-deploy-line or merle-customer-names). This is ${branch || 'no branch'}.`;
  if (!files.length) return 'Name each file to commit.';
  const paths = [];
  for (const f of files) {
    if (f.startsWith('-') || f.includes('\0')) return `${f} isn't a file name. Name each file.`;
    const abs = resolve(here, f);
    const rel = relative(root, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return `${f} isn't a file in this repo.`;
    if (rel.split(sep).includes('.git')) return `${f} is inside .git.`;
    let real = '';
    try {
      real = realpathSync(abs);
    } catch {
      return `${f} isn't there.`;
    }
    if (real !== join(root, rel)) return `${f} is a link, or inside one.`;
    if (!lstatSync(abs).isFile()) return `${f} isn't a file. Name each file.`;
    if (/^\.env/.test(basename(rel)) && !/\.(example|sample)$/.test(rel)) return `${f} can hold secrets.`;
    // 1 is "not ignored"; 0 is ignored, and anything else is a question git couldn't answer: both refuse.
    const ignore = spawnSync('git', ['-C', root, 'check-ignore', '--quiet', '--', rel], { stdio: 'ignore' });
    if (ignore.status !== 1) return `${f} is ignored by git.`;
    if (!git(root, 'status', '--porcelain', '--untracked-files=all', '--', rel))
      return `${f} has no changes.`;
    paths.push(rel);
  }
  const message = messageAt(root);
  if (!existsSync(message)) return 'Nothing written to commit. Run write or deploy-write first.';
  git(root, 'add', '--', ...paths);
  try {
    git(root, 'commit', '--quiet', '-F', message, '--only', '--', ...paths);
  } catch (err) {
    git(root, 'reset', '--quiet', '--', ...paths);
    return `git commit failed: ${String(err.stderr ?? err)
      .trim()
      .slice(0, 500)}`;
  }
  rmSync(message);
  return { branch, commit: git(root, 'rev-parse', 'HEAD'), files: paths };
}

// ---- CLI ------------------------------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'commit') {
    // Every word is a file: a flag is refused there, never read as one.
    const out = commitFiles(process.cwd(), rest);
    if (typeof out === 'string') {
      console.error(out);
      process.exit(1);
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  const opts = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--full') opts.full = true;
    else if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[++i];
    else pos.push(rest[i]);
  }
  const root = pos[0] ?? process.cwd();
  const endpoint = opts.endpoint ?? ENDPOINT;
  if (cmd === 'detect') console.log(JSON.stringify(detect(root), null, 2));
  else if (cmd === 'deploy-plan' || cmd === 'deploy-write') {
    // The deploy line: a plan shows each change and writes nothing; write runs only after the person said yes.
    // Always Merle's own address: no option, so nothing an agent passes can send the token elsewhere or into a command.
    const p = deployPlan(root);
    // What the person approved, as a fingerprint of every change: write writes that plan or nothing.
    const plan = createHash('sha256')
      .update(JSON.stringify(p.changes.map((c) => [c.file, c.content])))
      .digest('hex')
      .slice(0, 16);
    const shown = { ...p, changes: p.changes.map(({ content, ...c }) => c), line: LINE(), plan };
    if (cmd === 'deploy-write' && opts.plan !== plan) {
      console.error(
        'The repo changed since the plan you approved, or no --plan was given. Run deploy-plan again, show it, and ask again.',
      );
      process.exit(1);
    }
    if (cmd === 'deploy-write') {
      const wrote = writeDeploy(root, p);
      keepMessage(
        root,
        'Tell Merle when a deploy reaches production',
        `Merle asks customers if a fix works once it's live. This line tells it the deployed commit, and it can't fail the deploy.\n\nIt needs the MERLE_DEPLOY_TOKEN secret where the deploy runs: in Merle, Settings, the product, Deploys.\n\nChanged: ${wrote.join(', ')}`,
      );
      console.log(JSON.stringify({ ...shown, wrote }, null, 2));
    } else console.log(JSON.stringify(shown, null, 2));
  } else if (cmd === 'plan' || cmd === 'write') {
    if (!opts.product || !/^[a-z0-9-]{2,40}$/.test(opts.product) || !/^https:\/\//.test(endpoint)) {
      console.error(
        'Give --product <id> (lowercase letters, digits, dashes). --endpoint must start with https://.',
      );
      process.exit(1);
    }
    const p = plan(root, detect(root), {
      product: opts.product,
      endpoint: endpoint.replace(/\/$/, ''),
      full: !!opts.full,
      ...(opts.name ? { name: opts.name } : {}),
    });
    if (cmd === 'write') {
      const wrote = write(root, p);
      keepMessage(root, p.pr.title, p.pr.body);
      console.log(JSON.stringify({ wrote, todos: p.todos, secrets: p.secrets, pr: p.pr }, null, 2));
    } else
      console.log(
        JSON.stringify(
          {
            ...p,
            changes: p.changes.map(({ content, ...c }) => ({ ...c, lines: content.split('\n').length })),
          },
          null,
          2,
        ),
      );
  } else {
    console.error(
      'Run: node init.mjs detect|plan|write [--product <id> --name <name> --endpoint <url> --full] [dir], or deploy-plan [dir], or deploy-write --plan <plan> [dir], or commit <file>...',
    );
    process.exit(1);
  }
}
