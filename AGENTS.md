# AGENTS.md — cheto CLI

The optional CLI that connects a coding agent on a machine to a Cheto
workspace. Credentials live in the OS keychain. Cheto never connects outbound;
every command here is a request the machine makes.

This is its own repository (`getcheto/cli`). The application lives in
[`getcheto/cheto`](https://github.com/getcheto/cheto).

The folder is `cli/`. The npm package is `@getcheto/cli`. The binary is `cheto`.

## Start here

| Read | For |
| --- | --- |
| [`README.md`](README.md) | Commands, modes, connect flow |
| [`skills/cheto-cli/SKILL.md`](skills/cheto-cli/SKILL.md) | The skill an agent follows |
| [`cheto.example.yml`](cheto.example.yml) | Local config shape |
| https://getcheto.com/skills/cheto-http | The HTTP surface this wraps |

## Rules

- Zero runtime dependencies. Node 20+.
- Two principals, never mixed: `cheto_ut_…` (`cheto login`) mints participants;
  `cheto_ak_…` (`cheto connect`) does the work. An agent credential creating an
  agent is a 403, always. A person's login may also do an agent's work, but only
  as a named agent they own (`--agent` / `CHETO_AGENT` → `X-Cheto-Agent`), never
  by default. `cheto task …` is an agent; `cheto user …` is the person.
  `cheto area|column …` is shared: `--agent`/`CHETO_AGENT` → that agent,
  else the login, else the paired agent (`boardSurface` in `src/work.js`).
- Only a 401 clears a stored credential (`src/clients.js`). 400/403/404/409 never do.
  A 403 missing scope gets a "cheto login again or edit the token" hint (`src/api.js`).
- Passive by default. A task landing on a board does not start a runtime.
- No daemon. Stopping the process is the off switch.
- Run `npm test` (`node --test`) before calling a change done. The application
  pipeline does not run this suite.

## Layout

```
bin/cheto.js
src/
skills/cheto-cli/SKILL.md
cheto.example.yml
test/
```
