# knot bridge

Connects a coding agent on your machine to a Knot workspace.

```bash
knot connect knot_pair_ab12cd_XXXXXXXXXXXX   # once, from the Agents page
knot inbox check                              # is there anything? reports, acts on nothing
```

**Passive by default.** A task landing on a board does not start anything here.
Chat can reach the agent; work waits until you — or an explicit
`mode: auto` — release it. See [modes](#what-it-may-do--modes).

**The bridge is optional.** Knot's API is plain HTTP with a bearer token, and
everything below can be done with `curl` and a cron line — see
`laravel/docs/AGENT_RUNTIME.md`. The bridge exists to save you writing that
loop, not because Knot needs it.

## No dependencies

Node 20 or newer, and nothing else. No install step, no package tree, no
lockfile to audit. `node bin/knot.js` works from a checkout.

## Commands

Two kinds, and the split is the one the server makes: **you**, and **the agent
on this machine**. Only the first can create an agent — minting a participant is
a human action, and a leaked machine credential that could do it would turn one
laptop into an unbounded number of participants.

### You

| | |
|---|---|
| `knot login` | Authorize this terminal, by approving it in your browser |
| `knot whoami` | Who this machine is signed in as, and what it would run |
| `knot agent list` | Your agents, where each works, what is connected |
| `knot agent create <name>` | Create an agent. `--workspace <slug>` `--handle` `--charter` |
| `knot agent join <agent-id>` | Add it to another workspace. `--workspace <slug>` |
| `knot agent pair <membership>` | A single-use code for a machine to redeem |
| `knot agent disconnect <id>` | Disarm one machine. Siblings keep working |
| `knot logout --user` | Forget your credential on this machine |

`knot login` is the OAuth 2.1 device flow: the CLI prints a code, you approve it
in a browser you are already signed in to, and the CLI collects a scoped
credential. **No password is ever typed into the terminal**, no cookie is
copied, and nothing long-lived is pasted. Revoke it from the panel whenever you
like.

The device flow rather than a loopback redirect because agents frequently run
where there is no browser — a server, a container, an SSH session — and this is
the shape that still works there.

### The agent on this machine

| | |
|---|---|
| `knot connect <code>` | Redeem a pairing code. Stores the credential in the OS keychain |
| `knot inbox check` | Is there work? Prints **nothing** when there is none. For cron |
| `knot task verify <id>` | Is this task real, mine, and actionable now? |
| `knot task accept <id>` | Verify it, then say yes to it |
| `knot task comment <id> <text>` | Say something where the work is |
| `knot status` | Who am I, where am I, what mode am I in, is there work |
| `knot check` | One pass: heartbeat, read the inbox, hand over what the mode allows |
| `knot run` | The same, in a loop, waiting on the server between passes |
| `knot logout` | Forget the agent credential on this machine |

**Nothing runs on its own.** There is no daemon to install, and Knot never
connects to this machine — every command here is a request you make. Stopping
the process is the off switch, and it is a real one.

`inbox check` and `task verify` are the conservative pair: the first reports and
does not act, the second answers whether a task is worth acting on at all.
`--json` on either gives a script one object; `task verify` exits `0` when the
task is verified and actionable and `1` when it is not, so:

```bash
knot task verify 42 --json || exit 0
```

See [`AGENT_TRUST.md`](../laravel/docs/AGENT_TRUST.md) for why an agent should
never act on task-like text it did not verify.

### Every half hour, without a daemon

```cron
*/30 * * * * cd ~/Projects/demo && /usr/local/bin/knot inbox check --json >> ~/knot.log
```

Quiet when there is nothing, so it does not mail you forty times a day. Under
the default mode it reports and stops; nothing is executed by that line.

### Using Knot without the bridge at all

An agent with its own brain does not need any of this. It can call
`knot inbox check --json`, `knot task verify`, `knot task accept` and
`knot task comment` as tools, or the HTTP API directly, and decide for itself
when to look. Knot does not need to manage an agent's lifecycle to be useful to
it — the bridge is one client, not the runtime.

## Where the credential lives

macOS Keychain, or `libsecret` on Linux, through the OS `security` /
`secret-tool` binaries. If neither exists it falls back to
`~/.config/knot/credentials.json` with mode `600`, and says so — a fallback that
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

`knot check --run` overrides the mode for one pass, because a person typing it
is an authority a config file is not. It says so in the output when it does.

## Which agent it runs

`knot.yml` in the working directory, or `~/.config/knot/knot.yml`. The full
annotated version is in [`knot.example.yml`](knot.example.yml); the short one:

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
a line in your crontab runs `knot inbox check`, `poll` means you leave
`knot run` open. The bridge starts nothing on its own under any of them.

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
thing: while Knot had no tags, `tags:` was accepted as a synonym for `channels:`
because there was nothing else to point it at. Knot has tags now, so a config
written under the old reading filters on tags — which is what it said.

Outside the schedule nothing starts, the work stays in Knot untouched, and the
next pass inside the window picks it up. The window governs *starting*: a task
that begins at 23:58 is not interrupted at midnight.

The schedule is local policy. Knot has no idea this is a work laptop that closes
at midnight, and putting working hours on the shared Agent would make one
person's evening a property of an identity two people use.

### Not being rediscovered

A poll every thirty minutes finds the same task every time. Knot's own fields
answer most of that — a task in Review is not actionable, an accepted task is no
longer an offer — and the rest is remembered locally in
`~/.config/knot/handled-<host>.json`: which tasks this machine already handed
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
speaks as; without it the first entry in `knot.yml` decides, or the only agent
connected when there is only one. When several are connected and nothing picks
between them the command **refuses and lists them** rather than choosing — a
comment posted in the wrong agent's name cannot be taken back from here.

```bash
knot connect <code-for-qa>          # both survive; the second no longer
knot connect <code-for-kalel>       # lands on the first one's key

knot whoami                         # what is armed on this machine
knot check --agent qa-demo         # one pass, as that agent
knot logout --agent qa-demo        # forget one; --all forgets every one
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
