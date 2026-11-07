# dsh-node-client

`dshnc` — the node side of [dsh-nodes](https://github.com/unera/dsh-nodes):
it connects a machine to a DSH server, fetches commands, runs them inside a
sandbox and reports back.

Zero runtime dependencies. One foreground process, systemd-friendly, no daemon
libraries.

## Install

```sh
npm install -g unera/dsh-node-client
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

```json
{
  "max": "full",        // absolute ceiling, never exceeded
  "base": "rw",         // mode a command starts in; approved commands skip it
  "approver": "local",  // local | server | none
  "roots": ["/home/unera/work/ai"],
  "workdir": "/home/unera/work/ai/.dsh",
  "ask": {
    "local": { "enabled": true, "tool": { "type": "external", "command": "zenity --text-info --width=600" } }
  }
}
```

`dshnc policy` reads and edits it:

```sh
dshnc policy https://host/dsh-nodes max=full base=rw approver=local \
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

Polling pulls batches over HTTP; a WebSocket (`/v1/ws`, token in the
subprotocol, never in the URL) tells the client that work exists, so it does not
wait for the next poll. Without the socket the client still works, just with
poll latency.

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
- `доступ` — name, session directory, allowed directories, ceiling (`ro`/`rw`/
  `full`), starting mode, who answers questions, and the command used to ask
  (any tool that exits 0 on "yes", not just `zenity`);
- `связь` — periodic polling, socket ping interval and how far it may stretch;
- `автозапуск` — delegates to the systemd unit wizard;
- before writing, it prints the resulting config and asks for confirmation.

`dshnc config key=value` changes top-level settings, `dshnc policy <url> key=value`
changes per-server rules; both edit the file in place and keep its comments.

## Commands

| command | what it does |
|---|---|
| `dshnc connect <url>` | pairing link — at once, otherwise a request pending approval |
| `dshnc daemon [url...]` | announce APIs, fetch commands, answer; no arguments — every configured server |
| `dshnc status` | client id and saved servers |
| `dshnc policy [url] [key=value…]` | show or change policy for one server |
| `dshnc audit [n]` | commands executed without the sandbox |
| `dshnc workdir [path]` | show or set the session working directory |

One client serves several servers: token, cursor and epoch are kept **per URL**.

## Development

```sh
npm test     # node --test, sequential: integration tests start real servers
```

The Russian guide is in [`docs/guide.ru.md`](docs/guide.ru.md); storage rules,
policy and sandbox notes are in [`STORAGE.md`](STORAGE.md).
