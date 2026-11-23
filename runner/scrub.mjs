// Generated from Merle's own scrubber (scrub.ts) when the plugin is built. Don't edit it here.
var IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,4}){3,9}\b/g;
var CARD_RE = /\b(?:\d[\s_/·‑-]?){12,18}\d\b/g;

var PLACEHOLDER = /[[(](email|phone|number|id|name)(?: (\d+))?[\])]/gi;
var canon = (kind, n) => `[${kind.toLowerCase()}${n ? ` ${n}` : ""}]`;
var FILE = /^[a-z0-9_-]+\.(?:sh|html?|js|mjs|cjs|css|pdf|png|jpe?g|gif|svg|webp|json|xml|txt|csv|zip|md|ico|map|wasm)$/i;
var PERSONAL = /* @__PURE__ */ new Set([
  "customers",
  "customer",
  "users",
  "user",
  "people",
  "person",
  "contacts",
  "contact",
  "accounts",
  "account",
  "members",
  "member",
  "profiles",
  "profile",
  "u",
  // Other words and languages a path names people by.
  "clients",
  "client",
  "team",
  "teams",
  "kunden",
  "kunde",
  "benutzer",
  "konto",
  "konten",
  "mitglied",
  "mitglieder",
  "utilisateurs",
  "utilisateur",
  "compte",
  "comptes",
  "usuarios",
  "usuario",
  "clientes",
  "cliente",
  "cuenta",
  "cuentas"
]);
var LB = "";
var starts = (before, body, flags) => ({
  re: new RegExp(
    body.replace(LB, () => `(?<!${before})`),
    `g${flags}`
  ),
  again: new RegExp(
    body.replace(LB, () => ""),
    `y${flags}`
  )
});
var chained = (r, t, kind, rank, out) => {
  r.re.lastIndex = 0;
  for (let m = r.re.exec(t); m; m = r.re.exec(t)) {
    let e = m.index + m[0].length;
    out.push({ s: m.index, e, kind, rank });
    for (let k = 0; k < 4 && e + k < t.length; k++) {
      r.again.lastIndex = e + k;
      const n = r.again.exec(t)?.[0];
      if (!n) continue;
      out.push({ s: e + k, e: e + k + n.length, kind, rank });
      e += k + n.length;
      k = -1;
    }
    r.re.lastIndex = e;
  }
  return out;
};
var after = (r, t, kind, rank, out) => {
  let end = -1;
  for (const m of t.matchAll(r.head)) {
    const p = (m.index ?? 0) + m[0].length;
    if (r.name && !r.name.test(m.groups?.n ?? "")) continue;
    if (p < end) {
      if (!r.lead) continue;
      r.lead.lastIndex = p;
      if (!r.lead.test(t)) continue;
    }
    r.value.lastIndex = p;
    const v = r.value.exec(t)?.[0] ?? "";
    if (r.run) {
      r.run.lastIndex = p;
      r.run.exec(t);
      end = Math.max(end, r.run.lastIndex);
    } else end = Math.max(end, p + v.length);
    if (v.length >= (r.min ?? 1) && (!r.need || r.need.test(v)))
      out.push({ s: r.whole ? m.index ?? 0 : p, e: p + v.length, kind, rank });
  }
  return out;
};
var PERSON = [
  // A class that names a person the same way ("div.profile-zoe-keller", "a.user-zoe"), unless what follows is one word
  // a page names its own parts by ("a.user-menu", "div.profile-picture").
  [
    /\.(?:user|customer|account|member|profile|client|person|contact|kunde)[-_](?!(?:menu|settings|avatar|picture|photo|image|icon|name|email|list|nav|link|button|card|item|header|footer|panel|tab|form|field|row|info|details|dropdown|page)(?![\w-]))[\w-]+/gi,
    "id"
  ],
  // After a record word in prose, a quoted name or one joined by . _ or - is a name: 'Cannot find user "zoe"',
  // "User zoe.keller not found". "user settings" stays words.
  [
    {
      head: /\b(?:user|customer|member|account|profile|benutzer|kunde|utilisateur|usuario|cliente)\s+/giu,
      value: /"[^"\s]{1,40}"|'[^'\s]{1,40}'|[\p{L}\p{N}]+(?:[._:@-][\p{L}\p{N}]+)+/uy
    },
    "name"
  ]
];
var quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var anyCase = (w) => w.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);
var SECRET_NAME = new RegExp(
  `(?:${["key", "token", "secret", "password", "passwd", "passphrase", "pass", "pwd", "auth", "credentials?"].map(anyCase).join("|")})(?:_|[A-Z]|$)`
);
var NOT_A_VALUE = `
the a an my our your their his her its this that these those it them me you us him be is was and or not no
never also just still all any every each some one both too very only already now then there log login sign
access reset change get use unlock open enter make keep set protect prevent avoid stop match see check do
have go work type rejected changed wrong incorrect invalid expired accepted correct right empty blank
missing weak strong short long leaked stolen compromised updated saved sent lost forgotten fine ok okay
fixed removed deleted typed entered used shared given emailed stored hashed case required needed blocked
locked
`.trim().split(/\s+/);
var SECRETY = String.raw`\S{0,40}[\d=+/!@#$%^&*]|\p{L}{16}`;
var VALUE_AFTER_TO = (() => {
  const word = String.raw`(?=\S)(?:(?!(?:${NOT_A_VALUE.join("|")})[.,;:!?)\]"'”’…—]*(?!\S))|(?=${SECRETY}))`;
  return String.raw`(?=:\s*${word}|(?!:)${word}|${SECRETY})`;
})();
var PROSE_VALUE = { value: /(?::\s*)?\S{4,}/y, run: /(?::\s*)?\S*/y, lead: /:\s/y };
var PASSWORD_FOR = [0, 1, 2, 3].map(
  (k) => String.raw`\bpass(?:word|wort)${k ? String.raw`\s+(?:for|für)(?:\s+[\p{L}\p{N}_.'’()/-]{1,40}){${k}}` : ""}\s*`
);
var CREDENTIALS = [
  // Tokens: API keys, GitHub tokens, JWTs, bearer values.
  // A private key, whole: the markers and everything between them.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g,
    "id"
  ],
  // An AWS secret key, by its name or its shape next to an access key.
  [{ head: /AWS_SECRET_ACCESS_KEY\s*[=:]\s*["']?/g, value: /[A-Za-z0-9/+=]*/y, min: 30 }, "id"],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "id"],
  // Stripe, Slack, Google, GitLab and npm keys, by their shapes.
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "id"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "id"],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, "id"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "id"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "id"],
  // A login inside an address of any kind: "redis://:hunter2@host", "postgres://app:pa#ss@db", "postgresql://app:pw@/db".
  // The password may hold '?', '#' or ':'. Taking too much costs nothing: a port and a query with an address in it
  // ("localhost:3000?invite=anna@x.de") go as one placeholder, never in part.
  [/(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@?#]*:)[^\s/@]+(?=@)/gi, "id"],
  [/\bgh[pousr]_[A-Za-z0-9]{10,}/g, "id"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "id"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "id"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "id"],
  [{ head: /\bBasic\s+/g, value: /[A-Za-z0-9+/=]*/y, min: 8 }, "id"],
  // In prose too: "the password is …", "is now …", "das Passwort ist …", "lautet", "password:", with what it is for
  // ("for prod is"), any spaces between; what the value is, whatever it looks like.
  ...PASSWORD_FOR.map((head) => [
    {
      head: new RegExp(String.raw`${head}(?:(?:is|ist|lautet)\b|:)\s*`, "giu"),
      // "is now hunter2", "is now: hunter2" and "is now(x)": "now" goes with the value, a word or not.
      value: /(?:now(?:\s*:\s*|\s+))?(?::\s*)?\S{4,}/iy,
      run: /(?:now(?:\s*:\s*|\s+))?(?::\s*)?\S*/iy,
      lead: /now\s|now:\s|:\s/iy
    },
    "id"
  ]),
  // "set the password to …", "the old password was …": the next word, unless it starts a phrase (fails closed).
  ...PASSWORD_FOR.map((head) => [
    { head: new RegExp(String.raw`${head}(?:was|to)\b\s*${VALUE_AFTER_TO}`, "giu"), ...PROSE_VALUE },
    "id"
  ]),
  // A value after a word that names a secret ("bad key c2VjcmV0…", "token: abc123…"): with a digit or base64 padding.
  // The head looks back a bounded way, so it costs the same at each place.
  [
    {
      head: /(?<=\b(?:key|token|secret|pass(?:word|wort)?|pwd|api[- ]?key)\b[:=\s]{1,3})(?=\S)/gi,
      value: /\S*/y,
      min: 8,
      need: /[\d=+/]/
    },
    "id"
  ],
  // A quoted value after a setting's name, the name quoted or not, its quotes escaped any number of times or not, by
  // = : => := or $'…' ('"DB_PASSWORD": "two words"', "'password' => 'a b'", '{\"api_token\":\"…\"}', "api_key: `a b`"):
  // the whole value, spaces and escaped quotes in it too; one that never closes takes the rest of the line. The name
  // ends in a word for a secret, any case, or goes on only by `_` or a capital (clientSecretValue), so `passed` stays.
  ...['"', "'", "`"].map((q) => [
    {
      head: new RegExp(String.raw`\b(?<n>[A-Za-z0-9_]+)\\*["'${"`"}]?\s*(?:=>|:=|[=:])\s*\$?\\*${q}`, "g"),
      value: new RegExp(String.raw`(?:[^${q}\\\n]|\\.)*`, "y"),
      name: SECRET_NAME
    },
    "id"
  ]),
  // The same after a setting's name that ends in such a word ("STRIPE_SECRET_KEY=…", "DB_PASSWORD: …"), any value.
  [
    {
      head: /\b(?<n>[A-Za-z0-9_]+)["']?\s*[=:]\s*["']?/g,
      value: /[^\s"',;[\]]*/y,
      min: 4,
      name: /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)$/
    },
    "id"
  ],
  [{ head: /\bBearer\s+/gi, value: /[A-Za-z0-9._~+/=-]*/y, min: 8 }, "id"]
];
var RULES = [
  // An element id or data attribute that names a person: what the button makes of the host page's own ids.
  [/#(?:user|customer|account|member|profile|client|person|contact|kunde)[-_][\w.-]+/gi, "id", "first"],
  [
    {
      head: /\[data-(?:user|customer|account|email|name|member)[-\w]*=["']?/gi,
      value: /[^"'\]]+["']?\]/y,
      run: /[^"'\]]*/y,
      whole: true
    },
    "id",
    "first"
  ],
  // An address written for people: "anna at host dot com", "[at]", "(at)".
  [
    // Only an address: the last label is a domain ending, so "look at the dot on the screen" stays a sentence.
    // It starts only where a run of its letters starts, and each "at" and "dot" has one way through its spaces, so a
    // long word or run of spaces is read once.
    // Right where one ends, it may start again ("anna at x dot com.bob at corp dot com").
    starts(
      String.raw`[\p{L}\p{M}\p{N}._%+-]`,
      String.raw`${LB}[\p{L}\p{M}\p{N}._%+-]+(?:\s*(?:\[at\]|\(at\)|\{at\})\s*|\s+at\s+)[\p{L}\p{M}\p{N}-]+(?:(?:\s*(?:\.|\[dot\]|\(dot\))\s*|\s+dot\s+)[\p{L}\p{M}\p{N}-]+)*(?:\s*(?:\.|\[dot\]|\(dot\))\s*|\s+dot\s+)(?:com|net|org|io|co|de|fr|es|it|nl|uk|ch|at|eu|app|dev|test|me|ai|info|biz)\b`,
      "iu"
    ),
    "email",
    "first"
  ],
  // Letters of any script, with their combining marks (NFD text, Devanagari), and _ in domains: josé@acme.com,
  // jane@müller.de and jane@my_company.com are addresses too, whole.
  // A quoted local part ("jane doe"@acme.com) and a space before the dot (jane@acme .com) are addresses too.
  // Spaces around the @ and before the dots are still an address ("anna . schmidt @ acme . test"); a space only
  // after a dot is prose ("write to jane@acme. Then…").
  [
    // An unquoted local part starts only where it can't go on from what is before it (a letter, "x." or "x . "): any
    // later start would end where it does, so a long word is read once, never once per letter. Right where one ends,
    // it may start again ("anna@x.io%2Cbob@corp.com").
    starts(
      String.raw`[\p{L}\p{M}\p{N}_%+-](?:\.|\s\.\s?)?`,
      String.raw`(?:"[^"\n@]{1,64}"|${LB}[\p{L}\p{M}\p{N}_%+-]+(?:(?:\.|\s\.\s?)[\p{L}\p{M}\p{N}_%+-]+)*)\s?@\s?[\p{L}\p{M}\p{N}_-]+(?:(?:\.|\s\.\s?)[\p{L}\p{M}\p{N}_-]+)+`,
      "u"
    ),
    "email",
    "first"
  ],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "id"],
  [/\b[0-9a-f]{16,}\b/gi, "id"],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,15}\b/gi, "id"],
  [/\b\d{1,3}(?:\s?\.\s?\d{1,3}){3}\b/g, "id"],
  // An IBAN: two letters, two check digits, then 11 to 30 letters and digits (spaces allowed in groups).
  [IBAN_RE, "number"],
  // A card: 13 to 19 digits, in groups or not.
  [CARD_RE, "number"],
  [/\b(?:\d{4}[ ,.-]\s?){3}\d{4}\b/g, "number"],
  // A phone: a + or 00 and at least 7 more digits with the usual separators, or a national 0-prefixed number.
  [/(?:\+|\b00)\d[\d\s()._/·‑-]{6,}\d/g, "phone"],
  // Not a date like 03.11.2026. Each run of its signs is read once: a later start in it would end where this one does.
  [
    {
      head: /\b0(?!\d\.\d{2}\.\d{4}\b)\d/g,
      value: /[\d\s()._/·‑-]{7,}\d\b/y,
      run: /[\d\s()._/·‑-]*/y,
      whole: true
    },
    "phone"
  ],
  // An area code in brackets, then the local number: (11) 91234-5678, (21) 2345 6789.
  [/\(\d{2,3}\)\s?\d{4,5}[ .-]?\d{4}\b/g, "phone"],
  // National formats with no + or leading 0: 415-555-0199, (415) 555-0199, (415)555-0199, 415 555 0199, 415.555.0199.
  [/\(?\b\d{3}(?:\)[ .-]?|[ .-])\d{3}[ .-]?\d{4}\b/g, "phone"],
  // After a word that asks for a call, shorter numbers are phones too: "call 22 33 44 55", "Tel. 1234 5678".
  [
    /(?<=\b(?:call|ring|tel|phone|mobile|handy|whatsapp|telefon|nr|no)\.?:?\s{1,3}(?:me\s)?(?:on\s|at\s|under\s)?)\d[\d .-]{5,}\d/gi,
    "phone"
  ],
  // A date after a word for birth is a person's: "date of birth is 14.03.1985", "geboren am 3.5.1985".
  [
    /(?<=\b(?:birth|born|geboren|geb\.?|dob|né|nacido)\b[^\d\n]{0,16})\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/giu,
    "number"
  ],
  // Any nine or more digits broken up by the usual separators is a number someone dialled or was given.
  [/\b(?!\d{4}-\d{2}-\d{2}\b)(?:\d[ ._/·‑-]?){8,13}\d\b/g, "phone"],
  // IPv6: four or more hex groups joined by one or two colons ("12:30:45" is a time; "::1" is nobody's).
  [/\b[0-9a-f]{1,4}(?::{1,2}[0-9a-f]{1,4}){3,7}\b/gi, "id"],
  // Any run of six or more digits; shorter ones ("500 error", "round 3", "iOS 17") are left alone, unless a word for
  // a record stands right before them ("customer 10023", "order #4471").
  [/\b\d{6,}\b/g, "number"],
  [
    /(?<=\b(?:customer|user|account|order|member|kunde|konto|client|invoice|rechnung|ticket|case)\s?(?:id|nr|no)?\.?\s?#?\s?)\d{3,5}\b/gi,
    "number"
  ],
  // An extension right after a phone that was just taken out: "[phone 1] x23".
  [/(?<=\]\s?)(?:x|ext\.?)\s?\d{1,5}\b/gi, "phone"]
];
function scrubber(known = []) {
  const toReal = /* @__PURE__ */ new Map();
  const toMark = /* @__PURE__ */ new Map();
  const counts = { email: 0, phone: 0, number: 0, id: 0, name: 0 };
  const mark = (kind, real) => {
    const key = `${kind}:${real.toLowerCase()}`;
    const had = toMark.get(key);
    if (had) return had;
    const m = `[${kind} ${++counts[kind]}]`;
    toMark.set(key, m);
    toReal.set(m, real);
    return m;
  };
  const names = [
    ...new Set(
      known.map((n) => n.replace(/\u00a0/g, " ").trim()).filter((n) => n.length >= 2 && !/^\d+$/.test(n)).flatMap((n) => n.includes("@") ? [n] : [n, ...n.split(/[\s_+'’-]+/).filter((p) => p.length >= 3)])
    )
  ].sort((a, b) => b.length - a.length);
  const nameRe = names.length ? new RegExp(
    `(?<![\\p{L}\\p{N}@._+-])(?<!\\[)(?:${names.map(quote).join("|")})(?:'?s)?(?![\\p{L}\\p{N}@]|[._+-][\\p{L}\\p{N}@]|\\s\\d+\\])`,
    "giu"
  ) : null;
  const normalise = (s) => s.replace(new RegExp("\\p{Cf}", "gu"), "").replace(/\u00a0/g, " ").replace(/[\uff20\ufe6b]/g, "@").replace(/%40/gi, "@").replace(/&#64;|&commat;/gi, "@").replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65296 + 48)).replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 1632 + 48)).replace(/[\u06f0-\u06f9]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 1776 + 48)).replace(/[\u0966-\u096f]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 2406 + 48)).replace(new RegExp("\\b(\\p{Lu})\\.(\\p{Lu}\\p{Ll}+)", "gu"), "$1. $2");
  const handles = new Set(known.map((n) => n.trim().toLowerCase()).filter((n) => !/\s/.test(n)));
  const parts = new Set(
    names.map((n) => n.includes("@") ? n.slice(0, n.lastIndexOf("@")) : n).flatMap((n) => n.toLowerCase().split(/[\s._+'’-]+/)).filter((p) => p.length >= 3)
  );
  const all = (re, t, kind, rank, out) => {
    if ("again" in re) return chained(re, t, kind, rank, out);
    if (!(re instanceof RegExp)) return after(re, t, kind, rank, out);
    for (const m of t.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)))
      if (m[0]) out.push({ s: m.index ?? 0, e: (m.index ?? 0) + m[0].length, kind, rank });
    return out;
  };
  const segments = (p, at, inText, out) => {
    let afterPersonal = false;
    const segs = p.split("/");
    const host = /^[a-z][a-z0-9+.-]*:$/i.test(segs[0] ?? "") && segs[1] === "" ? 2 : -1;
    let pos = at;
    segs.forEach((seg, i) => {
      const start = pos;
      pos += seg.length + 1;
      if (!seg) return;
      if (seg === "." || seg === "..") {
        out.push({ s: start, e: start + seg.length, kind: "id", rank: 0 });
        return;
      }
      const personal = afterPersonal;
      const word = seg.split(";")[0]?.toLowerCase() ?? "";
      afterPersonal = PERSONAL.has(word) || inText && word === "home";
      const version = !personal && /^v\d{1,2}$/.test(seg);
      const record = !version && (personal || seg.startsWith("@") || /^\d+$/.test(seg) || /^[0-9a-f-]{8,}$/i.test(seg) || /\d/.test(seg) && new RegExp("\\p{L}", "u").test(seg) || new RegExp("[-\\d~;_+?=&[\\]\\p{Lu}]|\\P{ASCII}", "u").test(seg) || // A dot names a record ("jane.doe") unless it is the host or a file ("payload.sh", "index.html").
      seg.includes(".") && i !== host && !FILE.test(seg));
      if (record) out.push({ s: start, e: start + seg.length, kind: "id", rank: 0 });
    });
    return out;
  };
  const PATHLIKE = /(?<![\p{L}\p{N}:/[])\/[\p{L}\p{N}_~@.%-]+(?:\/[\p{L}\p{N}_~@.%;=,-]*)+/gu;
  const URL_HEAD = /\bhttps?:\/\//gi;
  const urls = (t) => {
    const out = [];
    let open = -1;
    URL_HEAD.lastIndex = 0;
    for (let m = URL_HEAD.exec(t); m; m = URL_HEAD.exec(t)) {
      const from = m.index + m[0].length;
      let i = from;
      while (i < t.length) {
        const c = t[i] ?? "";
        if (c === "[" && i >= open) {
          let j = i + 1;
          while (j < t.length && t[j] !== "]" && !/\s/.test(t[j] ?? "")) j++;
          if (t[j] === "]") {
            i = j + 1;
            continue;
          }
          open = j;
        }
        if (/[\s"'<>)\]]/.test(c)) break;
        i++;
      }
      if (i > from) out.push({ at: m.index, url: t.slice(m.index, i) });
      URL_HEAD.lastIndex = Math.max(i, URL_HEAD.lastIndex);
    }
    return out;
  };
  const HOMES = [/(?<=\b[a-z]:[\\/]users[\\/])[^\\/"'\n]+/gi, /(?<=[\\/](?:home|users)[\\/])[^/\\\s"')]+/gi];
  const JOINED = /(?<![\p{L}\p{N}])(@?)([\p{L}\p{N}]+(?:[-_.+@:][\p{L}\p{N}]+)+)/gu;
  const joined = (t, out) => {
    if (!parts.size) return out;
    for (const m of t.matchAll(JOINED)) {
      const [, at = "", w = ""] = m;
      if (at && handles.has(w.toLowerCase())) continue;
      if (!w.toLowerCase().split(/[-_.+@:]/).some((p) => parts.has(p)))
        continue;
      const s = (m.index ?? 0) + at.length;
      out.push({ s, e: s + w.length, kind: "name", rank: LAST });
    }
    return out;
  };
  const extensions = (t, spans) => spans.flatMap((x) => {
    const m = /^(\s?)((?:x|ext\.?)\s?\d{1,5})\b/i.exec(t.slice(x.e));
    const s = x.e + (m?.[1]?.length ?? 0);
    return m?.[2] ? [{ s, e: s + m[2].length, kind: "phone", rank: x.rank }] : [];
  });
  const scrub = (t, spans) => {
    spans.push(...extensions(t, spans));
    spans.sort((x, y) => x.s - y.s || y.e - x.e);
    const merged = [];
    for (const x of spans) {
      const last = merged.at(-1);
      if (last && x.s <= last.e) {
        last.e = Math.max(last.e, x.e);
        if (x.rank < last.first.rank || x.rank === last.first.rank && x.e - x.s > last.first.e - last.first.s)
          last.first = x;
      } else merged.push({ s: x.s, e: x.e, first: x });
    }
    const marks = /* @__PURE__ */ new Map();
    for (const x of [...merged].sort((a, b) => a.first.rank - b.first.rank || a.s - b.s))
      marks.set(x, mark(x.first.kind, t.slice(x.s, x.e)));
    let out = "";
    let pos = 0;
    for (const x of merged) {
      out += t.slice(pos, x.s) + marks.get(x);
      pos = x.e;
    }
    return out + t.slice(pos);
  };
  const LAST = 1e4;
  const values = (t) => {
    const out = [];
    RULES.forEach(([re, kind, first], i) => {
      if (first) all(re, t, kind, 1 + i, out);
    });
    if (nameRe) all(nameRe, t, "name", 100, out);
    CREDENTIALS.forEach(([re, kind], i) => {
      all(re, t, kind, 200 + i, out);
    });
    RULES.forEach(([re, kind, first], i) => {
      if (!first) all(re, t, kind, 300 + i, out);
    });
    PERSON.forEach(([re, kind], i) => {
      all(re, t, kind, LAST + i, out);
    });
    return joined(t, out);
  };
  const text = (s) => {
    const t = normalise(s);
    const spans = values(t);
    for (const { at, url } of urls(t)) {
      const u = /^(https?:\/\/[^/?#]+)([/?#].*)?$/i.exec(url);
      if (u?.[2]) segments(u[2], at + (u[1]?.length ?? 0), false, spans);
    }
    for (const m of t.matchAll(PATHLIKE)) segments(m[0], m.index ?? 0, true, spans);
    for (const re of HOMES) all(re, t, "name", LAST, spans);
    return scrub(t, spans);
  };
  const path = (p) => {
    const t = normalise(p);
    return scrub(t, segments(t, 0, false, values(t)));
  };
  const restore = (s) => s.replace(PLACEHOLDER, (m, kind, n) => toReal.get(canon(kind, n)) ?? m);
  const plain = (s) => s.replace(PLACEHOLDER, (_, kind) => canon(kind));
  const words = (s) => inWords(plain(s));
  const clean = (s) => plain(text(s));
  const cleanPath = (p) => plain(path(p));
  const cleanTrail = (trail) => trail.map((e) => {
    if (e.k === "click") return { ...e, selector: clean(e.selector), label: clean(e.label) };
    if (e.k === "input") return { ...e, selector: clean(e.selector) };
    if (e.k === "error") return { ...e, message: clean(e.message) };
    return { ...e, path: cleanPath(e.path) };
  });
  const cleanReport = (r) => ({
    ...r,
    text: clean(r.text),
    page: cleanPath(r.page),
    ...r.build ? { build: clean(r.build) } : {},
    trail: cleanTrail(r.trail)
  });
  return { text, path, restore, plain, words, clean, cleanPath, cleanTrail, cleanReport };
}
var WORDS = {
  email: "an email address",
  phone: "a phone number",
  number: "a number",
  id: "an id"
  // A name stays `[name]`: "the customer from the customer" would read worse than the bracket.
};
var inWords = (s) => s.replace(
  /(\/)?\[(email|phone|number|id)\]/gi,
  (m, slash, kind) => slash ? m : WORDS[kind.toLowerCase()] ?? m
);
var hasPlaceholder = (s) => new RegExp(PLACEHOLDER.source, "i").test(s);
export {
  hasPlaceholder,
  inWords,
  scrubber
};
