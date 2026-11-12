# dsh-node-client

`dshnc` — клиент [dsh-nodes](../dsh-nodes): объявляет машину узлом и исполняет
команды сервера. Умеет то, что приносят его плагины; из коробки — `bash`.

## Установка

Нужен Node 22 или новее (используется `node:sqlite` и встроенный `WebSocket`).

```sh
git clone https://github.com/unera/dsh-node-client
cd dsh-node-client
npm install -g .        # ставит исполняемый файл dshnc
dshnc help
```

Без установки тоже работает:

```sh
node /path/to/dsh-node-client/bin/dshnc.mjs help
```

Обновление — `git pull && npm install -g .`. Удаление — `npm uninstall -g dsh-node-client`;
состояние в `~/.dshnc` при этом остаётся, его удаляют руками.

## Подключение

Два способа, и первый короче.

**По ссылке из админки** — ничего подтверждать не нужно:

1. в админке DSH нажать «сгенерировать ссылку» (живёт 10 минут, срабатывает один раз);
2. на машине узла: `dshnc connect 'https://dsh.example/dsh-nodes/pair?v=...'`;
3. клиент сам получает токен: `подключено: узел 3 (nbw), токен сохранён`.

**Заявкой** — если ссылки нет:

```sh
dshnc connect https://dsh.example/dsh-nodes
# заявка отправлена: nbw / 7f3a-9c21
# в админке её надо «допустить» — клиент получит токен сам
```

Дальше в обоих случаях:

```sh
dshnc daemon
```

Состояние живёт в `~/.dshnc` (`DSHNC_HOME` переопределяет): `config.yaml` с id
клиента, адресом сервера и правилами доступа; токены — в `credentials.yaml`,
ключом по адресу, поэтому один файл токенов обслуживает несколько конфигов
(`dshnc -c <файл>`).

## Автозапуск

`daemon` работает на переднем плане; проще всего отдать это systemd:

```ini
# ~/.config/systemd/user/dshnc.service
[Unit]
Description=dsh-nodes client
After=network-online.target

[Service]
ExecStart=%h/.nvm/versions/node/v24.22.0/bin/dshnc daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now dshnc
journalctl --user -u dshnc -f
```

## Плагины

`bash` — первый плагин, но не единственный: всё, что клиент умеет, живёт в
плагинах. Встроенный `bash` лежит в пакете, свои плагины кладутся в
`~/.dshnc/plugins/<имя>/index.mjs` и подхватываются при запуске.

Плагин — один файл с двумя экспортами:

```js
// ~/.dshnc/plugins/lamp/index.mjs
export const api = {
  name: 'lamp',            // имя API, его увидит сервер
  version: '1',            // необязательно; меняется вместе с контрактом
  description: 'Лампа на столе',
  methods: [{
    method: 'set',
    description: 'Включить или выключить',
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
    return { ok: false, code: 'unknown_method', message: `нет метода ${command.method}` }
  }
  const { state } = command.args
  // ... сделать делом
  return { ok: true, results: [{ type: 'text', text: `лампа ${state}` }] }
}
```

Правила, которых стоит держаться:

- `api.methods[].args` — обязательное поле, хотя бы `{ type: 'object' }`: без
  схемы сервер отклонит объявление;
- `handle` возвращает `{ok: true, results: [...]}` или `{ok: false, code, message}`;
  `code` — из закрытого словаря сервера (`bad_args`, `timeout`, `internal`, …);
- `ctx` даёт `shell` и `signal` (отмена вызова);
- ошибка в плагине не роняет остальные: он выпадает с предупреждением в лог;
- имя API уникально: плагин, объявивший занятое имя, пропускается.

## Команды

| команда | что делает |
|---|---|
| `dshnc connect <url>` | подключение: ссылка с кодом — сразу, без кода — через заявку и одобрение |
| `dshnc daemon` | объявить API, забирать команды, отвечать; сервер берётся из конфига |
| `dshnc -c <файл> <команда>` | то же с другим конфигом (токены и состояние общие) |
| `dshnc onboard` | мастер: подключение (ссылка или токен), доступ, связь, автозапуск |
| `dshnc status` | id клиента, сервер и его состояние |
| `dshnc config [ключ=значение]` | настройки и правила доступа: показать или изменить |
| `dshnc help` | экран помощи |

Один конфиг обслуживает один сервер: адрес — ключ конфига, правила лежат рядом с
ним. Токены и `epoch` при этом хранятся по адресу в общих `credentials.yaml` и
`state.sqlite`, поэтому несколько конфигов (`dshnc -c <файл>`) не мешают друг
другу.

Присутствие — по WebSocket (`/v1/ws`, токен едет подпротоколом, не в URL): два
кадра `{t:'state', epoch, max_commandno}` («жду работы» плюс моё поколение и мой
последний исполненный номер) и `{t:'ping', no}`. Рукопожатия и курсора нет.
Опрос отсутствует: цикл просыпается только от кадра `state`.

## Что объявляет клиент

```
api: bash, version 1
  exec(command, cwd?, timeout?) → stdout, stderr, {code, signal, cwd}
```

Плюс всё, что найдено в `~/.dshnc/plugins/*` — каждый плагин объявляет свой API
и получает свои номера от сервера.

Вывод крупнее 48 КиБ обрезается с явной пометкой — модель должна видеть, что
ей показали не всё. Команда без ответа за свой `timeout` убивается по SIGKILL.

## Разработка

```sh
node --test test/*.test.mjs
```

Тест гоняет настоящий цикл клиента против настоящего сервера плагина.
