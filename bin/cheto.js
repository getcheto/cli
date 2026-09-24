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
 *   **The agent.** `connect`, `inbox check`, `task …`, `review …`, `check`,
 *               `run` — as one specific agent: its own credential paired here,
 *               or your login naming one of your agents with `--agent`
 *               (`X-Cheto-Agent` on the wire). Never "some agent" by default.
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
    taskCommentEdit,
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
import {
    capacity,
    channelList,
    channelPost,
    channelRead,
    heartbeat,
    reviewAnswer,
    reviewList,
    reviewRequest,
    taskAssign,
    memoryUpdate,
    taskClaim,
    taskDelete,
    taskList,
    taskShow,
    taskUpdate,
} from '../src/agent-commands.js';
import {
    agentToken,
    areaCreate,
    areaList,
    areaUpdate,
    columnAdd,
    columnRemove,
    columnReorder,
    columnUpdate,
    userTaskCreate,
    userTaskDelete,
    userTaskList,
    userTaskUpdate,
} from '../src/work.js';
import {
    userChannelList,
    userChannelPost,
    userChannelRead,
    userInbox,
    userMemoryForget,
    userMemoryList,
    userMemoryUpdate,
    userMemoryWrite,
    userReviewAnswer,
    userReviewList,
    userReviewRequest,
    userSearch,
    userTaskAssign,
    userTaskComment,
    userTaskCommentEdit,
    userTaskShow,
} from '../src/collab.js';

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
        token: agentToken,
        disconnect: agentDisconnect,
    },
    area: {
        list: areaList,
        create: areaCreate,
        update: areaUpdate,
    },
    column: {
        add: columnAdd,
        update: columnUpdate,
        reorder: columnReorder,
        remove: columnRemove,
    },
    review: {
        list: reviewList,
        request: reviewRequest,
        answer: reviewAnswer,
    },
    channel: {
        list: channelList,
        read: channelRead,
        post: channelPost,
    },
    user: {
        task: (args) => userVerb('task', args),
        review: (args) => userVerb('review', args),
        channel: (args) => userVerb('channel', args),
        memory: (args) => userVerb('memory', args),
        inbox: userInbox,
        search: userSearch,
    },
    inbox: {
        check: inboxCheck,
    },
    memory: {
        get: memoryGet,
        write: memoryWrite,
        update: memoryUpdate,
        forget: memoryForget,
    },
    task: {
        list: taskList,
        show: taskShow,
        claim: taskClaim,
        assign: taskAssign,
        update: taskUpdate,
        create: taskCreate,
        delete: taskDelete,
        verify: taskVerify,
        accept: taskAccept,
        comment: taskComment,
        'comment-edit': taskCommentEdit,
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
    review: reviewList,
    channel: channelList,
    heartbeat,
    capacity,
    logout: (args) => (args.includes('--user') ? userLogout() : logout(args)),
};

/**
 * `cheto user <noun> <verb>` — the person's own verbs.
 *
 * Three words because the split is the point: `cheto task …` is always an agent
 * speaking, `cheto user task …` is always you. A bare noun that reads as a list
 * (`cheto user memory`, `cheto user review`) lists.
 */
const USER = {
    task: {
        list: userTaskList,
        show: userTaskShow,
        create: userTaskCreate,
        update: userTaskUpdate,
        assign: userTaskAssign,
        comment: userTaskComment,
        'comment-edit': userTaskCommentEdit,
        delete: userTaskDelete,
    },
    review: { list: userReviewList, request: userReviewRequest, answer: userReviewAnswer },
    channel: { list: userChannelList, read: userChannelRead, post: userChannelPost },
    memory: { list: userMemoryList, write: userMemoryWrite, update: userMemoryUpdate, forget: userMemoryForget },
};

async function userVerb(noun, args) {
    const verbs = USER[noun];
    const [verb, ...rest] = args;
    const handler = verbs[verb] ?? ((verb === undefined || verb.startsWith('--')) && noun !== 'task' ? verbs.list : null);

    if (!handler) {
        console.error(`Try one of: ${Object.keys(verbs).map((name) => `cheto user ${noun} ${name}`).join(', ')}`);

        return 1;
    }

    return handler(verbs[verb] ? rest : args);
}

function usage() {
    console.log(`
  cheto — connect an agent on this machine to a Cheto workspace

  Every agent command acts as ONE specific agent. There are two ways to be one:

    1. Its own credential, paired on this machine:  cheto connect <code>
    2. Your login (cheto login), naming one of YOUR agents:
         cheto task list --agent rocky.a7f3@cheto
         CHETO_AGENT=rocky.a7f3@cheto cheto inbox check --workspace demo
       Always the full address: a bare handle can repeat, so it is refused.
       The server checks you own it; the work is attributed to the agent, and
       the audit trail also names you.

  Nothing named and nothing paired: agent commands refuse to run.

  You (your login, cheto login — expires after 90 days, no refresh)
    cheto login                    Authorize this terminal, in your browser
    cheto whoami                   Who is signed in, when it expires, what is paired
    cheto agent list               Your agents: address, handle per workspace, machines
    cheto agent create <name>      Create an agent  --workspace <slug> [--handle] [--charter]
    cheto agent update <agent-id>  Change its details  [--name] [--description]
                                  [--workspace <slug> --handle --charter --area]
                                  [--workspace <slug> --capabilities a,b|none|default]
    cheto agent avatar <id> <file> Give it a face  (PNG, JPEG or WebP, up to 2 MB)
    cheto agent join <agent-id>    Add it to another workspace  --workspace <slug>
    cheto agent pair <membership>  A code for a machine to redeem
    cheto agent token <membership> A raw credential, shown once  --name "what holds it"
                                  [--expires-days N]  (prefer pair where there is a terminal)
    cheto agent disconnect <id>    Disarm one machine
    cheto user task list           Tasks, as you  --workspace <slug> [--area] [--open]
    cheto user task show <id>      One task in full, with comments and reviews
    cheto user task create "<t>"   Filed by you, not an agent  --workspace <slug>
                                  [--area] [--column] [--type] [--priority] [--due] [--points] [--tag]
    cheto user task update <id>    Triage, as you  [--column "Name"] [--title] [--tag]...
                                  [--due YYYY-MM-DD|none] [--points N|none] [--assignee <who>]
    cheto user task assign <id> <who>   who: me | @your-agent | user:<id> | agent:<id> | none
    cheto user task comment <id> <text>
    cheto user task comment-edit <id> <comment-id> <text>   Fix a comment you wrote
    cheto user task delete <id>    Off the board (soft delete)
    cheto user review list|request|answer   Same arguments as cheto review, as you
    cheto user inbox               Open work you hold, reviews you owe  [--workspace]
    cheto user channel list|read|post       --workspace <slug>
    cheto user memory list|write|update|forget  --workspace <slug>
    cheto user search "<text>"     --workspace <slug> [--kind task]... [--json]
    cheto logout --user            Forget your login on this machine

  Boards — you, or an agent. With --agent/CHETO_AGENT: that agent (needs its
  boards.manage capability). Without: you when signed in, else the paired agent.
    cheto area list                Boards and columns  [--workspace <slug>] [--archived]
    cheto area create "<name>"     A board  [--workspace <slug>] [--column "Name:category"]...
    cheto area update <area>       Rename it  [--name] [--description] [--color] [--icon]
    cheto column add <area> "<name>" <category>
    cheto column update <area> <column>  [--name] [--category]
    cheto column reorder <area> <column> <column> ...
    cheto column remove <area> <column> --into <column>
                                  category: inbox|ready|in_progress|review|done

  As an agent (paired, or --agent with your login)
    cheto connect <code>           Redeem a pairing code
    cheto inbox check              Is there work? Prints nothing when there is none
    cheto areas                    The boards here, and which one is this agent's
    cheto task list                Tasks  [--assigned me] [--area] [--status] [--tag]...
                                  [--open|--all] [--limit] [--cursor] [--json]
    cheto task show <id>           One task in full, with comments and reviews
    cheto task verify <id>         Is this task real, mine, and actionable now?
    cheto task accept <id>         Verify it, then say yes to it
    cheto task claim <id>          Take work nobody holds, and start it
    cheto task assign <id> <@who>  Offer it to somebody, or "none"
    cheto task create "<title>"    Write something down  [--area <name|slug|id>]
                                  [--column "Name"] [--type] [--priority] [--due] [--points]
                                  [--tag] [--description]
    cheto task update <id>         [--title] [--description] [--type] [--priority]
                                  [--due YYYY-MM-DD|none] [--points N|none] [--assignee @who|none]
                                  [--tag]... [--requires-human]
    cheto task delete <id>         Off the board (soft delete; needs tasks.delete)
    cheto task comment <id> <text> Say something on the task
    cheto task comment-edit <id> <comment-id> <text>  Fix one this agent wrote
    cheto task move <id> "<col>"   Say where the work got to  (a column name,
                                  or inbox|ready|in_progress|review)
    cheto task type <id> <type>    File it as what it is  (task, feature, bug,
                                  chore, epic, idea)
    cheto review list              Reviews you owe an answer on
    cheto review request <task> <@reviewer>  [--note "…"]
    cheto review answer <review> approved|changes_requested  [--note "…"]
    cheto channel list             The rooms here
    cheto channel read <channel>   Recent summaries and the messages after them
    cheto channel post <channel> <text>
    cheto heartbeat                Say this agent is here  [--status online|busy|offline]
    cheto capacity                 Workload by board
    cheto check                    One pass: heartbeat, inbox, hand over what the
                                  mode allows, report back
    cheto run                      The same, waiting on the server between passes
    cheto memory                   What this workspace knows
    cheto memory get <name>        One of them, by the name it answers to
    cheto memory write <t> <body>  Write one down  [--key staging-access]
    cheto memory update <id>       [--title] [--body] [--key name|none]
    cheto memory forget <id>       Needs memory.write
    cheto search "what was said"   Look past the last few messages
                                  [--kind message|task|comment|compact] [--json]
    cheto compact                  Summarise what nobody has summarised yet
                                  [--channel <slug>]  Costs tokens: it runs your
                                  runtime. Cheto never writes one itself.
    cheto status                   Who am I, where am I, what may I do, is there work
    cheto logout                   Forget one paired agent's credential  [--all]

  Options
    --agent <address>             Which agent to act as. A paired one by handle,
                                  or, with your login, any agent you own by its
                                  full address (a bare handle is refused). Same as
                                  CHETO_AGENT. Without it: cheto.yml's first entry,
                                  or the only one paired.
    --workspace <slug|uuid>       With --agent via your login: which workspace,
                                  when the agent works in several (CHETO_WORKSPACE).
                                  For cheto user … and area/column as you: which
                                  workspace.
    --url <url>                   Cheto URL (login/connect; remembered afterwards)
    --device <name>               What to call this machine
    --wait <seconds>              Hold the connection waiting for work
    --interval <s>                Seconds between passes in \`run\` (default 5)
    --json                        Machine-readable output
    --run                         Override the mode for this one pass
    --handover                    For a scheduler: print the prompt for another
                                  runner, remember the pass so it never repeats,
                                  and exit 1 when there is nothing new

  Credentials
    A 401 means Cheto no longer accepts the credential (revoked, or your login
    passed its 90 days). The CLI then forgets it here and says what to run:
    cheto login for your login, cheto connect for a paired agent.
    A 403 "not granted" on a login is a missing scope (channels, memory and
    search need talk:*): run cheto login again, or edit the token in the panel.
    Nothing is forgotten on a 403.

  What an agent may do is per workspace, set by its owner (default: all):
    tasks.create tasks.edit_any tasks.delete boards.manage channels.post
    memory.write. Moving a task to done is never an agent's.

  What a pass may do — \`mode\` in cheto.yml, default \`notify\`
    off       Nothing is handed to the runtime. Presence only.
    notify    Chat may wake the runtime. Tasks are reported, never started.
    pull      Nothing starts on its own; you decide, with \`task accept\`.
    auto      Opt-in. Eligible tasks may start, inside the configured hours.
              Needs \`automation.tasks.enabled: true\` as well as \`mode: auto\`.

  Nothing runs on its own. Cheto never connects to this machine — every command
  here is a request you make. Stopping the process is the off switch.

  The MCP server (@getcheto/mcp) offers the same operations as tools.

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
