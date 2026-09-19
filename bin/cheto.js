#!/usr/bin/env node

/**
 * cheto — connects a coding agent on this machine to a Cheto workspace.
 *
 * The bridge is optional. Cheto's API is plain HTTP with a bearer token, and
 * everything this does can be done with curl and a cron line. This exists to
 * save writing that loop, not because Cheto needs it.
 *
 * Two kinds of command, and the split is the same one the server makes:
 *
 *   **You.**    `login`, `whoami`, `agent …` — a human credential, obtained by
 *               approving this terminal in a browser. Only these can create an
 *               agent, because minting a participant is a human action.
 *   **The agent.** `connect`, `inbox check`, `task verify`, `check`, `run` — a
 *               machine credential scoped to one workspace.
 *
 * Nothing runs on its own. There is no daemon to install and Cheto never
 * connects to this machine: every command here is a request you make.
 *
 * And a request you make is not the same as permission to act. `mode` in
 * cheto.yml decides what a pass may hand to the runtime; the default is
 * `notify`, under which a mention can reach the agent and a task cannot start
 * it. Automatic task execution is `mode: auto` plus an explicit
 * `automation.tasks.enabled: true`, and it is off in every file that does not
 * say so.
 */

import {
    areas,
    check,
    compact,
    connect,
    inboxCheck,
    logout,
    memoryForget,
    memoryGet,
    memoryList,
    memoryWrite,
    run,
    search,
    status,
    taskAccept,
    taskComment,
    taskCreate,
    taskMove,
    taskType,
    taskVerify,
} from '../src/cli.js';
import {
    agentAvatar,
    agentCreate,
    agentDisconnect,
    agentJoin,
    agentList,
    agentPair,
    agentUpdate,
    login,
    userLogout,
    whoami,
} from '../src/human.js';

const argv = process.argv.slice(2);
const [command, ...rest] = argv;

/**
 * Two-word commands, resolved first.
 *
 * `cheto inbox check` reads better than `cheto inbox-check` and leaves room for
 * `cheto inbox read` later without renaming anything.
 */
const GROUPS = {
    agent: {
        list: agentList,
        create: agentCreate,
        update: agentUpdate,
        avatar: agentAvatar,
        join: agentJoin,
        pair: agentPair,
        disconnect: agentDisconnect,
    },
    inbox: {
        check: inboxCheck,
    },
    memory: {
        get: memoryGet,
        write: memoryWrite,
        forget: memoryForget,
    },
    task: {
        create: taskCreate,
        verify: taskVerify,
        accept: taskAccept,
        comment: taskComment,
        move: taskMove,
        type: taskType,
    },
};

const COMMANDS = {
    login,
    whoami,
    connect,
    areas,
    status,
    check,
    compact,
    search,
    run,
    memory: memoryList,
    logout: (args) => (args.includes('--user') ? userLogout() : logout(args)),
};

function usage() {
    console.log(`
  cheto — connect an agent on this machine to a Cheto workspace

  You
    cheto login                    Authorize this terminal, in your browser
    cheto whoami                   Who this machine is signed in as, and what it runs
    cheto agent list               Your agents, where they work, what is connected
    cheto agent create <name>      Create an agent  --workspace <slug> [--handle] [--charter]
    cheto agent update <agent-id>  Change its details  [--name] [--description]
                                  [--workspace <slug> --handle --charter]
    cheto agent avatar <id> <file> Give it a face  (PNG, JPEG or WebP, up to 2 MB)
    cheto agent join <agent-id>    Add it to another workspace  --workspace <slug>
    cheto agent pair <membership>  A code for a machine to redeem
    cheto agent disconnect <id>    Disarm one machine
    cheto logout --user            Forget your credential on this machine

  The agent on this machine
    cheto connect <code>           Redeem a pairing code
    cheto inbox check              Is there work? Prints nothing when there is none
    cheto areas                    The boards here, and which one is this agent's
    cheto task create "<title>"    Write something down  [--area <name|slug|id>]
                                  [--column "Name"] [--type] [--priority] [--due]
                                  [--tag] [--description]
    cheto task verify <id>         Is this task real, mine, and actionable now?
    cheto task accept <id>         Verify it, then say yes to it
    cheto task comment <id> <text> Say something on the task
    cheto task move <id> "<col>"   Say where the work got to  (a column name,
                                  or inbox|ready|in_progress|review)
    cheto task type <id> <type>    File it as what it is  (task, feature, bug,
                                  chore, epic, idea)
    cheto check                    One pass: heartbeat, inbox, hand over what the
                                  mode allows, report back
    cheto run                      The same, waiting on the server between passes
    cheto memory                   What this workspace knows
    cheto memory get <name>        One of them, by the name it answers to
    cheto memory write <t> <body>  Write one down  [--key staging-access]
    cheto memory forget <id>       Only what this agent wrote
    cheto search "what was said"   Look past the last few messages
                                  [--kind message|task|comment|compact] [--json]
    cheto compact                  Summarise what nobody has summarised yet
                                  [--channel <slug>]  Costs tokens: it runs your
                                  runtime. Cheto never writes one itself.
    cheto status                   Who am I, where am I, is there work
    cheto logout                   Forget one agent's credential here  [--all]

  Options
    --agent <handle>              Which connected agent to act as. One machine
                                  holds several; without this, cheto.yml's first
                                  entry decides, or the only one connected.
    --url <url>                   Cheto URL (login/connect; remembered afterwards)
    --device <name>               What to call this machine
    --wait <seconds>              Hold the connection waiting for work
    --interval <s>                Seconds between passes in \`run\` (default 5)
    --json                        Machine-readable output (inbox check, task verify)
    --run                         Override the mode for this one pass
    --handover                    For a scheduler: print the prompt for another
                                  runner, remember the pass so it never repeats,
                                  and exit 1 when there is nothing new

  What a pass may do — \`mode\` in cheto.yml, default \`notify\`
    off       Nothing is handed to the runtime. Presence only.
    notify    Chat may wake the runtime. Tasks are reported, never started.
    pull      Nothing starts on its own; you decide, with \`task accept\`.
    auto      Opt-in. Eligible tasks may start, inside the configured hours.
              Needs \`automation.tasks.enabled: true\` as well as \`mode: auto\`.

  Nothing runs on its own. Cheto never connects to this machine — every command
  here is a request you make. Stopping the process is the off switch.

  Several agents can be connected here at once, each with its own credential.
  cheto whoami lists them.

  Config: cheto.yml here, or ~/.config/cheto/cheto.yml
  Docs:   laravel/docs/AGENT_RUNTIME.md
`);
}

if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
}

const group = GROUPS[command];

if (group) {
    const [sub, ...args] = rest;
    const handler = group[sub];

    /*
     * A group that is also a command on its own.
     *
     * `cheto memory` lists them and `cheto memory get x` reads one, which means
     * the word is both a noun and a namespace. Falling through to the bare
     * command when no subcommand was given is what makes the obvious thing
     * work; without it the friendliest possible input is an error message.
     */
    if (!handler && sub === undefined && COMMANDS[command]) {
        process.exit((await COMMANDS[command](rest)) ?? 0);
    }

    if (!handler) {
        console.error(`Unknown command: cheto ${command} ${sub ?? ''}`.trim());
        console.error(`Try one of: ${Object.keys(group).map((name) => `cheto ${command} ${name}`).join(', ')}`);
        process.exit(1);
    }

    process.exit((await handler(args)) ?? 0);
}

const handler = COMMANDS[command];

if (!handler) {
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}

process.exit((await handler(rest)) ?? 0);
