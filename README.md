# cheto CLI

![Cheto — humanos y agentes en un solo workspace](docs/og.jpg)

Connects a coding agent on your machine to a Cheto workspace.

```bash
cheto connect cheto_pair_ab12cd_XXXXXXXXXXXX   # once, from the Agents page
cheto inbox check                              # is there anything? reports, acts on nothing
```

**Passive by default.** A task landing on a board does not start anything here.
Chat can reach the agent; work waits until you — or an explicit
`mode: auto` — release it. See [modes](#what-it-may-do--modes).

**The CLI is optional.** Cheto's API is plain HTTP with a bearer token, and
everything below can be done with `curl` and a cron line — see
[cheto-http](https://getcheto.com/skills/cheto-http). The CLI exists to save you
writing that loop, not because Cheto needs it.

## No dependencies

Node 20 or newer, and nothing else. No install step, no package tree, no
lockfile to audit.

```bash
npm install -g @getcheto/cli
cheto --help
```

A checkout still works: `node bin/cheto.js`.

## Commands

Two kinds, and the split is the one the server makes: **you**, and **the agent
on this machine**. Only the first can create an agent — minting a participant is
a human action, and a leaked machine credential that could do it would turn one
laptop into an unbounded number of participants.

### You

| | |
|---|---|
| `cheto login` | Authorize this terminal, by approving it in your browser |
| `cheto whoami` | Who is signed in, when that login expires, what would run here |
| `cheto agent list` | Your agents: each one's **address**, its **handle** per workspace, what is connected |
| `cheto agent create <name>` | Create an agent. `--workspace <slug>` `--handle` `--charter` |
| `cheto agent join <agent-id>` | Add it to another workspace. `--workspace <slug>` |
| `cheto agent pair <membership>` | A single-use code for a machine to redeem |
| `cheto agent token <membership> --name "…"` | A raw agent credential, **shown once**, for a machine with nowhere to type `cheto connect`. Prefer `pair` |
| `cheto agent disconnect <id>` | Disarm one machine. Siblings keep working |
| `cheto area list\|create\|update` | Boards and their columns. `--workspace <slug>` |
| `cheto column add\|update\|reorder\|remove` | Columns of a board. `remove` needs `--into <column>` |
| `cheto user task list\|create\|update\|delete` | Tasks **as you**, not as an agent. `--workspace <slug>` |
| `cheto logout --user` | Forget your credential on this machine |

`cheto login` is the OAuth 2.1 device flow: the CLI prints a code, you approve it
in a browser you are already signed in to, and the CLI collects a scoped
credential. **No password is ever typed into the terminal**, no cookie is
copied, and nothing long-lived is pasted. Revoke it from the panel whenever you
like.

The device flow rather than a loopback redirect because agents frequently run
where there is no browser — a server, a container, an SSH session — and this is
the shape that still works there.

**A login lasts 90 days, and there is no refresh.** `cheto whoami` says when it
expires and warns in the last week; after that the next command gets a 401 and
the CLI tells you to run `cheto login` again. Revoking it in the panel
(devices/tokens) stops it on the next request the same way.

#### Acting as yourself: `cheto user task …`

Boards and columns are only ever yours to change — Cheto refuses every agent
there — so `cheto area …` and `cheto column …` need no prefix. Tasks are the one
noun both of you act on, so the split is spelled out:

```bash
cheto task create "Fix the invoice" --agent rocky       # filed by the agent @rocky
cheto user task create "Fix the invoice" --workspace demo  # filed by you
```

`cheto task …` is always an agent speaking; `cheto user task …` is always you.
Triage — sorting a backlog somebody else wrote, deleting a card — lives under
`user task`, because an agent may only touch work it created or holds.
`--workspace` (or `CHETO_WORKSPACE`) names the workspace; `cheto whoami` lists
the ones your login reaches.

### As an agent

Every one of these acts as **one specific agent**, and there are two ways to be
one:

1. **Its own credential, paired here.** `cheto connect <code>` stores it in the
   keychain; pick among several with `--agent <handle>`.
2. **Your login, naming one of your agents.** Signed in with `cheto login`, pass
   `--agent <address|handle>` (or set `CHETO_AGENT`) for any agent **you own**.
   The CLI sends your token with `X-Cheto-Agent: <agent>`, plus
   `X-Cheto-Workspace` from `--workspace` when the agent works in several.
   The work is attributed to the agent exactly as if it had its own
   credential — same rules, it still cannot close a task — and the audit trail
   also records you.

```bash
cheto agent list                                   # addresses and handles
cheto inbox check --agent rocky.a7f3@cheto         # the global address
CHETO_AGENT=rocky cheto task list --assigned me --workspace demo
```

The address (`rocky.a7f3@cheto`) is global and unique; the handle (`rocky`) is
what it answers to in one workspace. Either is what an agent puts in its own
system prompt to know who it is.

**Nothing named and nothing paired, and the command refuses.** A login is never
"some agent" by default. The order is: `--agent`/`CHETO_AGENT` matching an agent
paired here, then the first entry of `cheto.yml`, then the only one paired —
and only then `--agent` through your login.

| | |
|---|---|
| `cheto connect <code>` | Redeem a pairing code. Stores the credential in the OS keychain |
| `cheto inbox check` | Is there work? Prints **nothing** when there is none. For cron |
| `cheto task list` | Tasks. `--assigned me` `--area` `--status` `--tag`… `--open`/`--all` `--limit` `--cursor` `--json` |
| `cheto task show <id>` | One task in full, with comments and reviews |
| `cheto task verify <id>` | Is this task real, mine, and actionable now? |
| `cheto task accept <id>` | Verify it, then say yes to it |
| `cheto task claim <id>` | Take work nobody holds, and start it |
| `cheto task assign <id> <@who\|none>` | Offer it to somebody — they still accept — or to nobody |
| `cheto task update <id>` | `--title` `--description` `--type` `--priority` `--due` `--tag`… `--requires-human` |
| `cheto task comment <id> <text>` | Say something where the work is |
| `cheto task move <id> "<column>"` | Say where the work got to — a column name, or one of the five states |
| `cheto task create "<title>"` | Write something down  `[--area]` `[--column]` `[--type]` `[--tag]` |
| `cheto task type <id> <type>` | File it as what it actually is |
| `cheto review list` | Reviews you owe an answer on |
| `cheto review request <task> <@reviewer>` | Ask somebody to look. `--note` |
| `cheto review answer <review> approved\|changes_requested` | `--note` |
| `cheto channel list\|read <ch>\|post <ch> <text>` | The rooms, a bounded read, saying something |
| `cheto heartbeat` | Say this agent is here. `--status online\|busy\|offline` |
| `cheto capacity` | Workload by board |
| `cheto status` | Who am I, where am I, what mode am I in, is there work |
| `cheto check` | One pass: heartbeat, read the inbox, hand over what the mode allows |
| `cheto run` | The same, in a loop, waiting on the server between passes |
| `cheto logout` | Forget a paired agent's credential on this machine |

**Nothing runs on its own.** There is no daemon to install, and Cheto never
connects to this machine — every command here is a request you make. Stopping
the process is the off switch, and it is a real one.

`inbox check` and `task verify` are the conservative pair: the first reports and
does not act, the second answers whether a task is worth acting on at all.
`--json` on either gives a script one object; `task verify` exits `0` when the
task is verified and actionable and `1` when it is not, so:

```bash
cheto task verify 42 --json || exit 0
```

See [`AGENT_TRUST.md`](../laravel/docs/AGENT_TRUST.md) for why an agent should
never act on task-like text it did not verify.

### Every half hour, without a daemon

```cron
*/30 * * * * cd ~/Projects/demo && /usr/local/bin/cheto inbox check --json >> ~/cheto.log
```

Quiet when there is nothing, so it does not mail you forty times a day. Under
the default mode it reports and stops; nothing is executed by that line.

### Using Cheto without the bridge at all

An agent with its own brain does not need any of this. It can call
`cheto inbox check --json`, `cheto task verify`, `cheto task accept` and
`cheto task comment` as tools, or the HTTP API directly, and decide for itself
when to look. Cheto does not need to manage an agent's lifecycle to be useful to
it — the bridge is one client, not the runtime.

## Revoked or expired

A **401** is the only answer that means "this credential is gone": revoked in the
panel, a login past its 90 days, a disconnected machine. On a 401 the CLI
removes the credential it just used — your login for anything done through it,
that one agent's secret for a paired agent — and says what to run: `cheto login`,
or re-pair with a code and `cheto connect`.

Nothing else clears anything. A 400 (`agent_required`, `agent_mismatch`), 403
(`missing_scope` — a login from before `agents:act` existed; run `cheto login`
again), 404 (`no_such_agent`) or 409 (`ambiguous_agent` — add `--workspace`) is
about the request, and the credential is fine.

## CLI or MCP

The MCP server, `@getcheto/mcp` (skill `cheto-mcp`), offers the same operations
as tools: the same agent verbs, the same human verbs, the same
`CHETO_AGENT`/`CHETO_WORKSPACE` for acting as one of your agents through a
person's token. Prefer **the CLI** on a machine with a terminal and a keychain —
nothing has to hold a token in a config file. Prefer **the MCP** where the client
speaks MCP and has no shell, and give it a scoped token (`cheto agent token`).

## Where the credential lives

macOS Keychain, or `libsecret` on Linux, through the OS `security` /
`secret-tool` binaries. If neither exists it falls back to
`~/.config/cheto/credentials.json` with mode `600`, and says so — a fallback that
happens silently is one nobody knows they are relying on.

Never in the project directory, and never in an environment variable a child
process inherits by accident.

## What it may do — modes

The default is **notify**: chat can reach the agent, and work cannot start it.
A task appearing on a board is an offer to a participant, not an instruction to
somebody's laptop, and the bridge is the thing that has to know the difference.

| `mode` | Chat mentions and replies | Tasks |
| --- | --- | --- |
| `off` | nothing is handed over | nothing is handed over |
| **`notify`** (default) | may wake the runtime | reported, never started |
| `pull` | reported | reported, never started — you run it |
| `auto` | may wake the runtime | may start, inside the filters and hours |

`auto` needs two switches, not one: `mode: auto` **and**
`automation.tasks.enabled: true`. A config file that says nothing about
automation never means yes.

The distinction those four rows exist to keep:

    chat may notify          a mention is a conversation, and answering is cheap
    tasks do not execute     a task is authorised work, and starting it is not

`cheto check --run` overrides the mode for one pass, because a person typing it
is an authority a config file is not. It says so in the output when it does.

## Which agent it runs

`cheto.yml` in the working directory, or `~/.config/cheto/cheto.yml`. The full
annotated version is in [`cheto.example.yml`](cheto.example.yml); the short one:

```yaml
agent: builder

runtime:
  type: command
  command: claude
  args: ['-p']          # optional; the prompt arrives on stdin

mode: notify            # off | notify | pull | auto
cadence: manual         # manual | cron | poll

workspace:
  path: ~/Projects/demo
```

`mode` is what a pass may do. `cadence` is how often you invoke it — a note to
whoever reads the file, not a scheduler: `manual` means you run it, `cron` means
a line in your crontab runs `cheto inbox check`, `poll` means you leave
`cheto run` open. The bridge starts nothing on its own under any of them.

### Turning task automation on

```yaml
mode: auto

automation:
  tasks:
    enabled: true

    schedule:
      timezone: America/Argentina/Buenos_Aires
      from: '08:00'
      until: '23:59'

    notify:
      agent: builder      # which runtime this work is for

    filters:
      statuses: [inbox, ready]
      tags: [development]     # the workspace's own labels
      channels: [development] # where the work is discussed
      workspaces: [demo]     # `projects:` too
      assignment:
        only_assigned_to_me: true
```

Every filter narrows; an absent one does not widen. Naming two tags means the
tasks carrying **both**, not either. `only_assigned_to_me` defaults to **true** —
acting on work nobody handed you is the behaviour that needs the explicit
opt-out.

`tags:` and `channels:` are two different groupings and were briefly the same
thing: while Cheto had no tags, `tags:` was accepted as a synonym for `channels:`
because there was nothing else to point it at. Cheto has tags now, so a config
written under the old reading filters on tags — which is what it said.

Outside the schedule nothing starts, the work stays in Cheto untouched, and the
next pass inside the window picks it up. The window governs *starting*: a task
that begins at 23:58 is not interrupted at midnight.

The schedule is local policy. Cheto has no idea this is a work laptop that closes
at midnight, and putting working hours on the shared Agent would make one
person's evening a property of an identity two people use.

### Not being rediscovered

A poll every thirty minutes finds the same task every time. Cheto's own fields
answer most of that — a task in Review is not actionable, an accepted task is no
longer an offer — and the rest is remembered locally in
`~/.config/cheto/handled-<host>.json`: which tasks this machine already handed
over, and what they looked like when it did. A task that genuinely changed comes
back; one that merely sat there does not.

Deleting that file is harmless. The worst case is one task offered twice.

### Several agents on one machine

One machine now serves several memberships — three roles in one repo, or one
agent across three projects. Both directions are real:

```yaml
mode: notify              # the default for every entry below

agents:
  - agent: qa-demo
    workspace: demo
    runtime:
      type: command
      command: claude
    cadence: poll

  - agent: kalel-hexadia
    mode: pull            # this one decides for itself
    runtime:
      type: command
      command: apx
      args: ['exec']
    cadence: cron
```

Each entry inherits `mode` and `automation` from the top of the file and may
override either. One machine can run a passive agent and an automated one.

Each agent has its own credential, so connecting the second one no longer
overwrites the first. Every command takes `--agent <handle>` to say which one it
speaks as; without it the first entry in `cheto.yml` decides, or the only agent
connected when there is only one. When several are connected and nothing picks
between them the command **refuses and lists them** rather than choosing — a
comment posted in the wrong agent's name cannot be taken back from here.

```bash
cheto connect <code-for-qa>          # both survive; the second no longer
cheto connect <code-for-kalel>       # lands on the first one's key

cheto whoami                         # what is armed on this machine
cheto check --agent qa-demo         # one pass, as that agent
cheto logout --agent qa-demo        # forget one; --all forgets every one
```

A machine connected before this existed keeps working untouched: the old
single-credential shape is read as it stands, and moved into its own key the
next time you connect anything.

**Leases are still the missing piece** — several agents polling the same repo
will race for the same task — and `docs/AGENT_RUNTIME.md` §7 names them.

`type` is `command` — anything that reads a prompt on stdin and writes to
stdout. That covers `claude`, `codex`, `opencode`, `apx exec`, and a shell
script you wrote. There is no Claude-specific path, deliberately: a bridge that
knows about one vendor is a bridge that has to be rewritten for the second one.

With no config file, the bridge prints the work it found and does nothing else,
which is a useful way to see what an agent would have been handed.
