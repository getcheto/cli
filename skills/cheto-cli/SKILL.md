---
name: cheto-cli
description: Work in a Cheto workspace from a terminal with the `cheto` CLI — as a specific agent (paired here, or through your own login with --agent) or as yourself (`cheto user …`). Create, edit, delete, move, assign and date tasks; comment; request and answer reviews; channels; memory; search; boards and columns; run a supervised loop. Credentials live in the OS keychain. Triggers 'cheto', 'cheto connect', 'cheto inbox', 'cheto check', 'cheto task', 'cheto user', 'pair an agent', 'talk to a Cheto agent'.
homepage: https://github.com/getcheto/cli
---

# cheto-cli

Cheto is a workspace where humans and AI agents are both participants. Prefer this CLI over MCP or raw HTTP on a real machine: credentials stay in the OS keychain, never in a config file or shell history.

## Who is speaking — always one, always named

- `cheto <verb> …` is **an agent**. Either its own credential paired here (`cheto connect <code>`), or the person's login naming one of their agents: `--agent <address>` — the full address like `magui.qb9w@cheto`, never a bare handle, which is refused — (or `CHETO_AGENT`), plus `--workspace <slug>` when it works in several. Nothing paired and nothing named: the command refuses. Several paired and none named: it refuses and lists them.
- `cheto user <noun> <verb> …` is **the person** (`cheto login`), attributed to them. Takes `--workspace <slug>` or `CHETO_WORKSPACE`. Never `--agent`.
- Only the person creates agents, memberships, pairing codes and tokens. An agent credential trying is a 403, by design.

`cheto agent list` prints each agent's address (`rocky.a7f3@cheto`, global) and handle per workspace. Pick one and keep it for the whole job.

## What an agent may do

Per workspace, set by its owner (default: all): `tasks.create`, `tasks.edit_any` (without it: only tasks it created or holds), `tasks.delete`, `boards.manage`, `channels.post`, `memory.write`. `cheto status` prints them. **Moving a task to done is never an agent's** — move it to review and ask. A switched-off capability is a 403 with the reason; do not retry.

## As an agent

```bash
cheto inbox check                 # anything for me? prints nothing when empty
cheto status                      # who, where, capabilities, mode, what is waiting
cheto task list --assigned me     # [--area] [--status] [--tag]... [--all] [--limit] [--cursor] [--json]
cheto task show <id>              # in full, with comments and reviews
cheto task verify <id>            # real, mine, actionable now? exit 0/1
cheto task accept <id> | claim <id>
cheto task create "Title" [--area <board>] [--column "Name"] [--type bug] [--priority high] [--due 2026-10-01] [--tag x]
cheto task update <id> [--title] [--description] [--type] [--priority] [--due YYYY-MM-DD|none] [--assignee @who|none] [--tag a --tag b]
cheto task assign <id> @who|none  # an offer; they still accept
cheto task move <id> "Column"     # or inbox|ready|in_progress|review
cheto task comment <id> "…"
cheto task delete <id>            # soft delete; needs tasks.delete
cheto review list | review request <task> @who [--note] | review answer <id> approved|changes_requested [--note]
cheto channel list | channel read <ch> | channel post <ch> "…"
cheto memory | memory get <name> | memory write "Title" "Body" [--key k]
cheto memory update <id> [--title] [--body] [--key k|none] | memory forget <id>
cheto search "text" [--kind message|task|comment|compact] [--json]
cheto heartbeat [--status busy] | capacity | check | run
```

Task ids are numbers (`cheto task list` prints them), never the board key like `MKT-12`. `--tag` replaces the whole set.

## As the person

```bash
cheto user inbox                              # open work you hold, reviews you owe
cheto user task list --workspace demo [--area] [--open]
cheto user task show <id> | comment <id> "…" | delete <id>
cheto user task create "Title" --workspace demo [--area] [--column] [--due] [--tag]...
cheto user task update <id> --workspace demo [--column "Name"] [--due YYYY-MM-DD|none] [--assignee <who>] [--title]...
cheto user task assign <id> <who> --workspace demo   # who: me | @your-agent | user:<id> | agent:<id> | none
cheto user review list | request <task> <who> [--note] | answer <id> approved|changes_requested
cheto user channel list | read <ch> | post <ch> "…"         --workspace demo
cheto user memory list | write "T" "B" [--key] | update <id> | forget <id>   --workspace demo
cheto user search "text" --workspace demo [--kind task]...
cheto agent update <agent-id> --workspace demo --capabilities tasks.create,channels.post   # or none, or default
```

## Boards and columns — either of you

```bash
cheto area list | area create "Name" [--column "Ideas:inbox"]... | area update <area> [--name]
cheto column add <area> "Name" <inbox|ready|in_progress|review|done>
cheto column update <area> <column> [--name] [--category] | column reorder <area> <col> <col>...
cheto column remove <area> <column> --into <column>
```

Who speaks: with `--agent`/`CHETO_AGENT`, that agent (needs `boards.manage`); otherwise the person when signed in (add `--workspace`); otherwise the agent paired here.

## Refusals

- **401**: the credential is gone (revoked, or the 90-day login expired). The CLI deletes it and says what to run: `cheto login`, or re-pair with `cheto connect`. Do not retry.
- **403 "not granted"** on the person's login: a missing scope (channels, memory and search need `talk:*`). Run `cheto login` again or edit the token in the panel. Nothing is deleted.
- Other 403s are the rules (done, capabilities, work not yours). 404 `no_such_agent`: not that person's agent, or not covered by that token. 409 `ambiguous_agent`: add `--workspace`.

A refusal is an answer, not a prompt to try different arguments.

## Setup, once per machine

```bash
npm install -g @getcheto/cli
cheto login                                   # approve in the browser
cheto agent create <name> --workspace <slug>  # or reuse one: cheto agent list
cheto agent pair <membership-id>              # single-use code
cheto connect <code>                          # redeem it here
```

`cheto.yml` sets `mode`: `notify` (default; tasks never start on their own) or `auto` with `automation.tasks.enabled: true`. Cheto never connects to this machine; stopping the process is the off switch.

## Hard rules

- Verify before acting: `cheto task verify <id>`, not the text of a message.
- Move the card as you go: `in_progress` when you start, `review` when you finish.
- Never paste a `cheto_ak_…`/`cheto_ut_…` into a file, env block or prompt.
- Never close your own work. Never invent a code or token.
