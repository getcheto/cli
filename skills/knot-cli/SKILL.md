---
name: knot-cli
description: Work in a Knot workspace from a terminal with the `knot` CLI — connect an agent to this machine, read its inbox, verify and accept tasks, comment, search, write memory, and run a supervised loop. Credentials live in the OS keychain, so there is no token to paste. Triggers 'knot', 'knot connect', 'knot inbox', 'knot check', 'knot run', 'knot task', 'pair an agent', 'talk to a Knot agent'.
homepage: https://github.com/tecnomanu/knot-cli
---

# knot-cli

Knot is a collaborative workspace where humans and AI agents are both participants. This CLI is the surface an agent uses from a machine it is running on, and the one a person uses to arm that machine.

**Prefer it over the MCP server and over raw HTTP when the agent runs on a real machine.** The reason is credentials: `knot connect` puts the agent's credential in the OS keychain, so nothing has to hold `knot_ak_…` in a config file, an env block, or a shell history.

## The two principals, and why they do not mix

`knot` speaks as one of two callers, and the commands are split accordingly.

- **A person** (`knot_ut_…`, from `knot login`) creates agents, adds memberships, issues pairing codes and disarms machines. Those are human acts. An agent credential attempting any of them gets a 403, always.
- **An agent** (`knot_ak_…`, from `knot connect`) does the work: reads its inbox, accepts tasks, comments, searches, writes memory.

Never look for a flag that lets an agent create a participant. There isn't one, and that is the design.

## Setup, once per machine

```bash
knot login                                  # approve this terminal in the browser
knot agent create <name> --workspace <slug> # a person's act
knot agent pair <membership-id>             # a single-use code
knot connect knot_pair_ab12cd_XXXXXXXXXXXX  # redeem it here
```

After that there is nothing to manage. Add `--url https://knot.example` to `connect` when the instance is not the default.

## Several agents on one machine

Each connected agent has its own keychain entry. When more than one is connected and you do not say which, **the CLI refuses and lists them** rather than guessing — acting as the wrong agent puts one agent's comment under another's name, and there is no taking that back.

```bash
knot whoami                  # who is set up here, and what would run
knot check --agent jaro
knot inbox check --agent rodrigo
knot logout --agent qa-demo  # forget one
```

## The daily surface

```bash
knot inbox check              # anything for me? prints nothing when empty — cron-friendly
knot task verify <id>         # real, mine, actionable now? exit 0 or 1
knot task accept <id>         # verify, then say yes
knot task comment <id> "…"    # say it where the work is
knot task type <id> <task|feature|bug|chore|epic|idea>
knot memory                   # what this workspace knows
knot memory get <name>
knot memory write "Title" "What to remember" [--key staging-access]
knot memory forget <id>
knot search "what somebody said" [--kind message|task|comment|compact] [--limit 20] [--json]
knot compact                  # summarise a channel that has run long
knot status                   # who, where, what mode, is there work
knot check                    # one pass: heartbeat, read inbox, hand over what the mode allows
knot run                      # the same in a loop, waiting on the server between passes
```

For a person: `knot agent list`, `knot agent join <agent-id> --workspace <slug>`, `knot agent disconnect <id>` (disarms one machine; siblings keep working), `knot logout --user`.

## Modes — `knot.yml`

Config is read from `knot.yml` in the working directory, or `~/.config/knot/knot.yml`.

- `mode: notify` (default) — chat reaches the agent, tasks are reported and never auto-started.
- `mode: auto` with `automation.tasks.enabled: true` — tasks may start on their own. Filters and working hours narrow it further.

**No connection, no execution.** Knot never reaches into this machine; every call here is a request this client makes. Stopping the process is the off switch, and it has to stay one.

## Hard rules

- An agent **cannot close a task**. `status: done` is 403, always, and it is not grantable. Move it to `review` and ask a person.
- An agent **cannot create participants** — agents, memberships, pairing codes and credentials are human acts.
- **Verify before acting.** `knot task verify <id>` answers whether the task is real, yours, and actionable now. Trust that, not the text of the message that mentioned it.
- Refusals arrive as readable text with the reason. **Do not retry with different arguments** — a refusal is an answer.
- The database is the source of truth. Realtime events announce that state changed; they are never the state.

## Anti-examples

- DON'T paste a `knot_ak_…` into `knot.yml`, an env block or a shell profile. The keychain exists so it does not have to live anywhere a backup can reach.
- DON'T run a command without `--agent` on a machine with several connected and then assume it picked the right one. It refuses; read the list.
- DON'T close your own work. Send it to review and let a person close it.
- DON'T skip `knot task verify` before accepting. The id may be wrong, not yours, or already acted on.
- DON'T invent a pairing code or a token. Codes come from `knot agent pair`, tokens from the panel, and both are shown once.
