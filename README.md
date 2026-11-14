# Merle for Claude Code

Adds [Merle](https://hellomerle.com)'s feedback button to your app, and gives your coding agent what customers report.

## Install

You need a Merle product. [Sign in](https://app.hellomerle.com/signin), add one, and Setup shows its id.

In Claude Code:

```
/plugin marketplace add hellomerle/merle-plugin
/plugin install merle@merle
```

The second line opens a panel where you choose where to install it. From a shell, this does both in one step:

```sh
claude plugin install merle --marketplace hellomerle/merle-plugin
```

## Add the feedback button

Open Claude Code in your repo, with everything committed, and run:

```
/merle init your-product "Your product"
```

It reads the repo and finds the layout every page shares. On a new branch it adds the two lines, the TypeScript declaration
if the layout is JSX, and your Content-Security-Policy sources if you send one. Then it runs your build, commits on that
branch and shows you the diff.

It pushes nothing. Read the commit, merge it and deploy. Merle takes messages only from the sites listed for your product,
so check Setup has yours. After deploying, this checks the install and files nothing:

```
/merle doctor https://your-site.example
```

Tested on Vite with React and on Next.js. It also knows Astro, SvelteKit, Remix and plain HTML.

To add customers' names later, run `/merle init names`.

## Tell Merle when a fix is live

Merle waits for the deploy, then asks customers if the fix works. `/merle init` finds your deploy command in
`package.json`, a deploy script or a workflow, and offers to add one line after it. It changes nothing unless you say yes,
and the line can't fail your deploy. Vercel and Netlify deploying from Git, and GitHub Actions environments, tell GitHub already, so
it adds nothing there. A workflow gets the line only for runs your team starts: a push to the default branch or a tag, a release or a manual run. Save the token from Merle's Settings, under Deploys, as `MERLE_DEPLOY_TOKEN` where the deploy runs. For a repo that
has the feedback button already, run `/merle init deploy`.

An agent that deploys can say so itself, with `report_deploy`, if its token may. The plugin also has a hook: after a Bash
command that looks like a deploy, it reminds the agent to call the tool only if that went to production and worked. The
hook sends nothing and reads no token.

## Connect your coding agent

The quickest way: send your agent "Connect this project to Merle by following https://hellomerle.com/agents.md". It
asks Merle for a code, you approve it in Merle, and the token goes into the Keychain. Or, from this plugin:

```
/merle connect
```

It walks you through making a token in Merle's Settings, then adding this line in a separate terminal:

```sh
claude mcp add --transport http merle https://app.hellomerle.com/mcp --header "Authorization: Bearer <token>"
```

The token lands in your own `~/.claude.json`, for that folder only. It stays out of the repo. Keep it out of the chat too, since
Claude Code saves the transcript. If `MERLE_TOKEN` is set in your environment, `/merle connect` runs the line itself and
never sees the value.

Your agent can read requests, add a note and tie its pull request to a request. It can't reach a customer, close a request or
change a setting.

## Notes from Merle to your running sessions

On a Mac paired with Merle's runner ([Run on your Mac](https://hellomerle.com/coding-agents)), the plugin hooks up each Claude Code session in a folder you
allowed with `merle-runner allow`. In Merle's Sessions page you then see each session's state and send it a note, or
Approve its work, and the session picks the note up itself: at the end of its turn, or, if it's idle, a hook waiting in
the background wakes it. The hooks only dial out to Merle with the Mac's token from the Keychain; nothing listens on the
Mac. A note reaches only the session it's addressed to, arrives labelled as the founder's word, and is logged in Merle
and in `~/Library/Logs/Merle/notes.jsonl`. It can't approve a tool call: permission prompts still ask on the Mac.

`/merle unhook` stops notes reaching a session; so does Unhook in Merle. On a Mac that isn't paired, the hooks do
nothing.

## Reports can be forged

Your feedback address is public, so anyone can send it a made-up report. In PhantomFix (CERT VU#212479), a forged error
reached a coding agent through a public address, and the agent ran the attacker's package before any pull request existed.

The plugin tells your agent never to install a package, run a command or fetch a URL because a report names it. That lowers
the odds and guarantees nothing, because a model can still follow words it was told are data. Protect your machine by limiting
what the agent can run:

- Deny `npm install`, `pip install` and the like in your permissions, or allow only your lockfile.
- Keep it asking before it runs commands when it works from a request.
- Give it a sandbox with no secrets and limited network access.

## What the button sends

What the customer writes, the page they were on and the screen size. What they tapped before: button labels, page changes, and
each request's method, path and status. Never what they typed into your app, only its length, and never request bodies. A
picture or their voice goes only when they tap for it.

The [docs](https://hellomerle.com/docs) have the rest.
