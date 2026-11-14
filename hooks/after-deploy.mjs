// A Claude Code hook (PostToolUse on Bash). It runs after a command that worked, and when that command looks like a
// deploy it reminds the agent of the rule: tell Merle only about a production deploy you ran yourself. It sends nothing,
// reads no token and never fails: a skill's duty is easy to miss, and a reminder at the right moment is cheap. Whether it
// was production is the agent's call: the words of a command can't say.
import { runsDeploy } from '../skills/merle/deploys.mjs';

let input = '';
process.stdin.on('data', (d) => {
  input += d;
});
process.stdin.on('end', () => {
  try {
    const e = JSON.parse(input);
    const command = e?.tool_name === 'Bash' ? String(e?.tool_input?.command ?? '') : '';
    if (!command || !runsDeploy(command)) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            "That command looked like a deploy. If it went to production and worked, and Merle's report_deploy tool is there, call it with the commit you deployed. If it was a preview, staging, a dry run or it didn't finish, don't.",
        },
      }),
    );
  } catch {
    // Input it can't read: say nothing. A hook must never stand in the agent's way.
  }
});
