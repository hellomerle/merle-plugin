// `/merle doctor`: checks a deployed product end to end, the way a customer's browser reaches it (Node 18+).
// Run: node doctor.mjs --product your-product --site https://your-site.example [--endpoint <Merle's address>]
// With MERLE_IDENTITY_SECRET set it also signs a test customer and checks the edge accepts the token; with
// MERLE_TEST_TOKEN (a provider JWT copied from the browser) it checks that instead. Neither is ever printed.
// Nothing is filed: the origin check sends an empty message the edge refuses before it reads it.
import { createHmac } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ENDPOINT = 'https://feedback.hellomerle.com';

/** @typedef {{ ok: boolean | null, what: string, fix?: string }} Result */

/**
 * @param {{ endpoint: string, product: string, site: string, secret?: string, token?: string }} o
 * @param {typeof fetch} f
 * @returns {Promise<Result[]>}
 */
export async function doctor(o, f = fetch) {
  const api = `${o.endpoint.replace(/\/$/, '')}/v1/p/${encodeURIComponent(o.product)}`;
  const host = new URL(o.endpoint).origin;
  const site = new URL(o.site).origin;
  /** @type {Result[]} */
  const out = [];
  const get = (url, init) => f(url, init).catch(() => null);

  const health = await get(`${host}/health`);
  out.push(
    health?.ok && (await health.text()).trim() === 'ok'
      ? { ok: true, what: `Merle answers at ${host}` }
      : { ok: false, what: `Merle doesn’t answer at ${host}/health`, fix: 'Check the endpoint address.' },
  );

  const box = await get(`${host}/button.js`);
  out.push(
    box?.ok && /javascript/.test(box.headers.get('content-type') ?? '')
      ? { ok: true, what: `The feedback button loads from ${host}/button.js` }
      : {
          ok: false,
          what: `${host}/button.js doesn’t load (${box?.status ?? 'no answer'})`,
          fix: 'Check the endpoint address.',
        },
  );

  // An empty message from the site: 400 means the product exists and takes this site; 404 means it doesn't.
  const origin = await get(`${api}/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: site },
    body: '{}',
  });
  out.push(
    origin?.status === 400
      ? { ok: true, what: `${o.product} takes messages from ${site}` }
      : {
          ok: false,
          what: `${o.product} doesn’t take messages from ${site} (${origin?.status ?? 'no answer'})`,
          fix: `Add ${site} to the product's origins in Merle's setup.`,
        },
  );

  const page = await get(o.site, { headers: { accept: 'text/html' } });
  const html = page?.ok ? await page.text() : '';
  out.push(
    html.includes('<merle-feedback')
      ? { ok: true, what: `The feedback button is on ${o.site}` }
      : {
          ok: null,
          what: `No <merle-feedback> in ${o.site}'s HTML`,
          fix: 'Fine if your app adds it in the browser; otherwise deploy the install change.',
        },
  );
  // Every policy applies: the header's and the page's own <meta> one (Astro writes its hashes there).
  const meta = /http-equiv=["']Content-Security-Policy["'][^>]*?content=(["'])(.*?)\1/i.exec(html)?.[2] ?? '';
  const policies = [
    page?.headers.get('content-security-policy') ?? '',
    meta.replace(/&#39;|&apos;/g, "'"),
  ].filter(Boolean);
  if (policies.length) {
    const allows = (d) =>
      policies.every((csp) => {
        const rule = csp.split(';').map((r) => r.trim().split(/\s+/));
        const named = (n) => rule.find((r) => r[0] === n);
        const src = named(d) ?? (d === 'frame-src' ? named('child-src') : null) ?? named('default-src');
        return !src || src.includes(host) || src.includes('*') || src.includes(new URL(host).protocol);
      });
    const missing = ['script-src', 'connect-src'].filter((d) => !allows(d));
    out.push(
      missing.length
        ? {
            ok: false,
            what: `${site}'s CSP blocks Merle (${missing.join(', ')})`,
            fix: `Add ${host} to ${missing.join(' and ')}.`,
          }
        : { ok: true, what: `${site}'s CSP lets the feedback button load and send` },
    );
    if (!allows('frame-src'))
      out.push({
        ok: false,
        what: `${site}'s CSP blocks the browser check (frame-src)`,
        fix: `Add ${host} to frame-src. Until then messages arrive, and each one waits for a person.`,
      });
  }

  const token =
    o.token ??
    (o.secret
      ? (() => {
          const p = Buffer.from(
            JSON.stringify({ id: 'merle-doctor', exp: Math.floor(Date.now() / 1000) + 300 }),
          ).toString('base64url');
          return `${p}.${createHmac('sha256', o.secret).update(p).digest('base64url')}`;
        })()
      : null);
  if (!token)
    out.push({
      ok: null,
      what: 'Sign-in not checked',
      fix: 'Set MERLE_IDENTITY_SECRET (your own sign-in) or MERLE_TEST_TOKEN (a provider token) to check it.',
    });
  else {
    const me = await get(`${api}/me/messages`, { headers: { origin: site, 'x-merle-user': token } });
    out.push(
      me?.status === 200
        ? { ok: true, what: 'A signed-in customer’s token is accepted' }
        : {
            ok: false,
            what: `A signed-in customer’s token is refused (${me?.status ?? 'no answer'})`,
            fix: 'The back office says why under Setup. Usually the secret or the provider’s issuer and audience.',
          },
    );
  }

  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { endpoint: { type: 'string' }, product: { type: 'string' }, site: { type: 'string' } },
  });
  if (!values.product || !values.site) {
    console.error('Run: node doctor.mjs --product <id> --site <your site> [--endpoint <Merle’s address>]');
    process.exit(1);
  }
  const results = await doctor({
    endpoint: values.endpoint ?? ENDPOINT,
    product: values.product,
    site: values.site,
    ...(process.env.MERLE_IDENTITY_SECRET ? { secret: process.env.MERLE_IDENTITY_SECRET } : {}),
    ...(process.env.MERLE_TEST_TOKEN ? { token: process.env.MERLE_TEST_TOKEN } : {}),
  });
  for (const r of results)
    console.log(
      `${r.ok === true ? '✓' : r.ok === false ? '✗' : '–'} ${r.what}${r.fix ? `\n    ${r.fix}` : ''}`,
    );
  process.exit(results.some((r) => r.ok === false) ? 1 : 0);
}
