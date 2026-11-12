# dsh-node-client

`dshnc` — the node side of [dsh-nodes](https://github.com/unera/dsh-nodes):
it connects a machine to a DSH server, fetches commands, runs them inside a
sandbox and reports back.

Zero runtime dependencies. One foreground process, systemd-friendly, no daemon
libraries.

## Install

```sh
npm install -g @dr-co/dsh-node-client
systemctl --user restart dshnc
```

## Connect

```sh
dshnc connect 'https://host/dsh-nodes/pair?v=<code>'   # pairing link
dshnc daemon                                            # serve every configured server
```

## Built-in APIs

Everything the client can do lives in a plugin. Two ship in the box.

**`bash`** — run a shell command.

```
exec(command, cwd?, timeout?) → stdout, stderr, {"code":…,"signal":…,"cwd":…,"sandbox":{…}}
```

Output above 48 KiB is truncated with a visible marker. A command that outlives
its timeout is killed. The `sandbox` block in the last result is the client's
honest report: the mode it actually ran in, whether the kernel denied something
and under which signature (`read-only file system` and the like).

**`job`** — long-running processes.

```
start(command, cwd?, timeout?) → {id, status}
output(id, offset?)            → {status, code, stdout, stderr, offset, sandbox}
kill(id, signal?)              → SIGTERM to the whole process group
list()                        → what runs and how it ended
```

A job runs through the same sandbox as `exec`: the mode that would confine a
command confines its background process too. Output is kept in a ring (256 KiB)
and read by absolute offsets; `sandbox` in the answer says whether isolation was
applied. Jobs die with the daemon: sandboxed ones through `--die-with-parent`,
the rest through `stopAll()` on SIGTERM.

**`files`** — reading and writing without a shell.

```
read(path, offset?, limit?)                     → {text, version, size, truncated}
write(path, content, ifVersion?, createDirs?)   → {version, bytes}
edit(path, old, new, replaceAll?, ifVersion?)   → {version, replaced}
list(path)                                      → {entries: [{name, type, size, mtime}]}
stat(path)                                      → {exists, type, size, version}
```

Paths are checked against `roots` **before** touching the disk: `/etc/hostname`
answers `path_denied`, not "read it anyway". Writes are atomic (temp file plus
`rename`), and `ifVersion` turns a silent overwrite into a `stale` error.
`edit` refuses ambiguity: a string found twice without `replaceAll` gives
`ambiguous_edit`.

**`session`** — session state on the node, version 4.

```
chdir(path)              → move the session workdir inside the allowed roots
mkdir(path, mode?)       → create a directory for the session
cwd()                    → where the session currently is
approve(id, text, mode)  → ask the human on this machine; returns ok/cancel
ping()                   → {pong, sentAt, rttMs, upSeconds, platform, version}
```

`ping` is the cheap liveness check: the node answers with its own clock and
uptime, and the server fills `rttMs` and `clockSkewMs` — the node cannot time a
round trip because it has never seen the server clock. It answers even on a node
without a session store, and the server caps it at 15 seconds: a hung node must
not hold the model for its full timeout.

The tool is started with these variables, so a dialog can show what is being
asked and remember a standing answer:

| variable | meaning |
|---|---|
| `DSHNC_APPROVAL_ID` | id of this question |
| `DSHNC_APPROVAL_MODE` | mode that is being requested |
| `DSHNC_SESSION` | model session; "answer yes until the end of this session" |
| `DSHNC_QUESTION` | root call of the turn; "until the end of this question" |
| `DSHNC_CALL` | the exact call, for logs |

`approve` is deliberately not a shell command: it runs the tool configured in
`ask.local.tool` (a `zenity` dialog, a script, anything), never goes through the
sandbox, and cannot be denied by the kernel. Without a configured tool it fails
with `no_local_approver` instead of pretending a question was asked.

Bump the API version whenever its contract changes. The version is the
**contract** version: nodes announcing different versions of the same name stay
separate, and fusing them would make the server use whichever schema it saw
first.

## Write your own plugin

Drop a directory into `~/.dshnc/plugins/<name>/index.mjs`; it is loaded at
startup and its API is announced to the server.

```js
export const api = {
  name: 'lamp',                 // what the server will see
  version: '1',                 // bump with the contract
  description: 'Desk lamp',
  methods: [{
    method: 'set',
    description: 'Turn on or off',
    args: {
      type: 'object',
      properties: { state: { type: 'string', enum: ['on', 'off'] } },
      required: ['state'],
      additionalProperties: false,
    },
  }],
}

export async function handle (command, ctx) {
  if (command.method !== 'set') {
    return { ok: false, code: 'unknown_method', message: `no method ${command.method}` }
  }
  return { ok: true, results: [{ type: 'text', text: `lamp ${command.args.state}` }] }
}
```

`args` is mandatory (at least `{ type: 'object' }`): the server refuses an
announcement without a schema. `handle` returns `{ok: true, results: [...]}` or
`{ok: false, code, message}` with a code from the server's vocabulary
(`bad_args`, `timeout`, `internal`, …). `ctx` carries `shell`, `signal`
(cancellation of that call), `sandbox`, `sessions` and `approver`.

A plugin that throws is dropped with a warning; the rest keep working. A plugin
claiming a name that is already taken is skipped.

## Sandbox and policy

The owner of the machine decides what the server may do. Policy lives on the
node, not on the server:

```yaml
max: full        # absolute ceiling, never exceeded
base: rw         # mode a command starts in; approved commands skip it
approver: local  # local | server | none
roots: [/home/unera/work/ai]
workdir: /home/unera/work/ai/.dsh
ask:
  local: { enabled: true, tool: { type: external, command: "zenity --text-info --width=600" } }
```

`dshnc config` reads and edits it:

```sh
dshnc config max=full base=rw approver=local \
  tool="zenity --text-info --width=600"
```

The template in `ask.local.tool` either contains `%s` (the question is
substituted into an argument) or not (the question goes to stdin, as
`zenity --text-info` expects — then its length is unbounded). Structured data
travelling with the question arrives in `DSHNC_APPROVAL_ID` and
`DSHNC_APPROVAL_MODE`. The command is started without a shell, so nothing from
the question can become shell syntax.

Sandboxing uses `bwrap` when it is available: `ro` is a read-only bind of `/`,
`rw` adds writable binds for `roots`, `full` runs unconfined. `no_new_privs` is
set, so `sudo` and setuid do not work inside. Network is unshared in `ro`/`rw`.

## Audit

Commands executed without a sandbox leave a trace:

```sh
dshnc audit 20
```

Rows are kept in a ring (2000 rows, 7 days) — a node that lives for months must
not fill the disk with a log nobody reads.

## Control channel

Batches are pulled over HTTP; a WebSocket (`/v1/ws`, token in the subprotocol,
never in the URL) tells the client that work exists. There is no polling: the
client sleeps until a `state` frame arrives. The frames are exactly two —
`{t:'state', epoch, max_commandno}` ("I am waiting", my generation, my own last
executed number) and `{t:'ping', no}`. There is no handshake and no cursor.

Batches run in parallel with a cap (`maxConcurrent`, default 5): one model turn
can produce a dozen calls, and a node must not be flooded. `session.chdir` is
applied first and in order — it changes the session working directory, so the
rest of the batch must start in the new one. `session.approve` runs outside the
pool: a dialog may hang for a day and must not hold a slot.

## MCP (planned)

The client is a natural place to bridge MCP servers: a local MCP server becomes
one more API on the node, and the model reaches it through `nodes_call` without
learning new tools. Two transports are wanted:

| transport | how it is configured | note |
|---|---|---|
| stdio | `command` + `args`, client spawns the process | works for `npx @modelcontextprotocol/server-*`, no network |
| `host:port` | URL of an HTTP/SSE endpoint | the server may live elsewhere, the node only proxies |

An MCP server named `files` would be announced as API `mcp-files` with one
method per MCP tool, the tool's JSON Schema reused as `args`. Nothing in the
protocol changes: the server already passes arbitrary schemas through.

Not implemented yet. When it is, the section will say so plainly instead of
describing intentions.

## First-run setup

`dshnc onboard` is a menu-driven wizard: it asks one section at a time and
explains what each answer means, because the answers are policy — who may do what
on this machine — not cosmetics.

- current values are shown in brackets and an empty answer keeps them, so the
  wizard never silently changes a node that already works;
- `подключение` — a pairing link from the admin page (with a code it connects at
  once, without one it waits for approval), or the address plus a token pasted by
  hand: both end with the address in the config and the token in `credentials.yaml`;
- `доступ` — name, session directory, allowed directories, ceiling (`ro`/`rw`/
  `full`), starting mode, who answers questions, and the command used to ask
  (any tool that exits 0 on "yes", not just `zenity`);
- `связь` — periodic polling, socket ping interval and how far it may stretch;
- `автозапуск` — delegates to the systemd unit wizard;
- before writing, it prints the resulting config and asks for confirmation.

`dshnc config key=value` shows or changes the settings and the rules; it edits the
file in place and keeps its comments.

### One node, one server, one config

A client serves exactly one server: the address is a key of the config, and the
access rules sit next to it instead of repeating per-server sections.

```yaml
server: https://dsh.uvw.ru/dsh-nodes
name: mx.uvw.ru
workdir: /home/unera/work
roots: [/home/unera/work]
max: rw          # ceiling: ro | rw | full
base: rw         # the mode a command starts in
approver: none   # who answers "allow wider": local | server | none
```

A second node on the same machine is a second config:

```
dshnc -c /etc/dshnc/backup.yaml daemon
```

The state stays common: `credentials.yaml` keeps the tokens of every address (they
are keyed by URL), `state.sqlite` their runtime, so two configs never overwrite
each other.

### State on disk

```
~/.dshnc/config.yaml       settings: server, name, aliases, workdir, rules
~/.dshnc/credentials.yaml  node tokens of every known address (0600)
~/.dshnc/state.sqlite      runtime: epoch, API numbers, session workdirs, audit
```

`config.yaml` is written from a commented template on the first run, so the keys
explain themselves where they are read. Older files are migrated once on the first
start: a per-server `policy` map is flattened into the top-level keys, and a
`config.json` becomes `config.yaml`, the original staying as `config.json.bak`.
Comments in the YAML survive every `dshnc config` edit.

## Install

```
npm install -g @dr-co/dsh-node-client
```

The same thing straight from git, without npm:

```
npm install -g unera/dsh-node-client
```

### Upgrading from the unscoped package

The package used to be published as `dsh-node-client`, without a scope. Both names
install the same `dshnc` binary, and npm refuses to overwrite it:

```
npm error EEXIST: file already exists
npm error path .../bin/dshnc
```

Remove the old package first — that is all the conflict is about:

```
npm uninstall -g dsh-node-client
npm install -g @dr-co/dsh-node-client
```

Both give you the `dshnc` binary. The git form follows `main`, the npm form gives
you a tagged release — pick npm for a node that has to keep working.

## Commands

| command | what it does |
|---|---|
| `dshnc connect <url>` | pairing link — at once, otherwise a request pending approval |
| `dshnc daemon` | announce APIs, fetch commands, answer; the server is the one named in the config |
| `dshnc -c <file> <cmd>` | same with another config file (the tokens and the runtime stay shared) |
| `dshnc status` | client id, the server and its state |
| `dshnc config [key=value…]` | show or change settings and rules |
| `dshnc audit [n]` | commands executed without the sandbox |
| `dshnc workdir [path]` | show or set the session working directory |

One config serves one server. Tokens live in a single `credentials.yaml` keyed by
address, so several configs (`-c`) share them and never overwrite each other.

## Development

```sh
npm test     # node --test, sequential: integration tests start real servers
```

The Russian guide is in [`docs/guide.ru.md`](docs/guide.ru.md); storage rules,
policy and sandbox notes are in [`STORAGE.md`](STORAGE.md).
