/**
 * Язык сообщений клиента: китайский, английский (по умолчанию) и русский.
 *
 * Источник истины — локаль: `DSHNC_LANG`, затем `LC_ALL`, затем `LANG`. Язык,
 * которого нет в словаре, не ошибка: падаем на английский. Так же и с
 * отсутствующим ключом — берём английский, чтобы сообщение никогда не было
 * пустым.
 *
 * @module dsh-node-client/i18n
 */

export const LANGS = ['en', 'ru', 'zh']

const DICT = {
  en: {
    'auto.copyState': 'Move the current state (token, cursor) to {dir}? [y/N]',
    'auto.copied': 'State copied: {dir}',
    'auto.copyFailed': 'Could not copy the state ({message}) — run `dshnc connect <link>` as {user}',
    'auto.copySkip': 'Leaving the state here; the new user will need `dshnc connect <link>`',
    'help.autostart': 'autostart                questions and a systemd unit',
    'unit.description': 'dsh-nodes client (dshnc) — remote commands executor',
    'auto.title': 'Setting up autostart (systemd)',
    'auto.name': 'Node name',
    'auto.aliases': 'Aliases, comma separated (the node can be called by any)',
    'auto.scope': 'Run as system service [system] or inside your user session [user]',
    'auto.dedicated': 'Create a dedicated system user for it? [y/N]',
    'auto.username': 'User name',
    'auto.createUser': 'No rights to create users. Run this and press Enter when done:',
    'auto.waitingUser': 'waiting for user {user}…',
    'auto.graphical': 'Start only inside the graphical session (needs DISPLAY)? [y/N]',
    'auto.written': 'Unit written: {path}',
    'auto.next': 'Now, as a user with rights:',
    'auto.stateDir': 'State (token, cursor) lives in {dir}',
    'auto.copyConfig': 'Copying the existing state to {dir}',
    'auto.noToken': 'No token yet: after install run `sudo -u {user} dshnc connect <link>`',
    'auto.done': 'Done.',
    'bash.arg.stdin': 'Data passed to the command on stdin (up to 64 KiB)',
    'bash.api.description': 'Shell on the node machine',
    'bash.exec.description': 'Run a command in the shell and return stdout, stderr and exit code',
    'bash.arg.command': 'Command line',
    'bash.arg.cwd': 'Working directory',
    'bash.arg.timeout': 'Timeout in seconds',
    'help.title': 'dshnc — dsh-nodes client ({home})',
    'help.connect': 'connect <url>            connect: a link with a code does everything,',
    'help.connect2': '                         without a code — request and wait for approval',
    'help.daemon': 'daemon [url...]          work: declare bash, take commands, reply;',
    'help.daemon2': '                         without arguments — every server from the config;',
    'help.daemon3': '                         runs in the foreground (background via systemd/nohup)',
    'help.foreground': '--foreground             kept for compatibility, same behaviour',
    'help.status': 'status                   client id and saved servers',
    'help.help': 'help                     this screen',
    'help.env': 'Environment: DSHNC_HOME (state directory), DSHNC_SHELL (default /bin/sh), DSHNC_LANG (en, ru, zh)',
    'status.id': 'client id:  {id}',
    'status.name': 'name:       {name}',
    'status.none': 'no servers yet — start with `dshnc connect <url>`',
    'status.server': '{url}: {token}, cursor {cursor}, epoch {epoch}{alias}',
    'status.token.yes': 'token present',
    'status.token.no': 'no token',
    'status.alias': ', node {alias}',
    'cmd.unknown': 'unknown command: {command}',
    'err.needUrl': 'a url is required: dshnc connect https://host/dsh-nodes/pair?v=...',
    'err.nothingToServe': 'nothing to serve: run `dshnc connect <url>` first',
    'err.generic': 'error: {message}',
    'err.aborted': 'aborted',
    'connect.paired': 'connected: node {node} ({alias}), token saved',
    'connect.requested': 'request sent: {name} / {short}',
    'connect.waiting': 'the admin has to approve it at {base}/admin — waiting',
    'connect.approved': 'approved: node {node} ({alias}), token saved',
    'connect.rejected': 'the request was rejected',
    'connect.handed': 'the token was already handed out; reissue it in the admin',
    'connect.timeout': 'the request was not approved within 30 minutes',
    'connect.done': 'done. next: dshnc daemon',
    'connect.noCode': 'the link carries no code — connection impossible',
    'daemon.servers': 'servers: {servers}',
    'daemon.plugins': 'plugins: {plugins}',
    'daemon.stopping': 'stopping',
    'run.announced': '{base}: declared {apis}, epoch {epoch}',
    'run.warning': 'warning: {warning}',
    'run.reconnect': '{base}: the server is of another life (epoch {from} → {to}), cursor reset',
    'run.restarted': '{base}: the server restarted (epoch {from} → {to}), cursor reset',
    'run.presenceClosed': '{base}: presence closed ({code}), falling back to polling',
    'run.retry': '{base}: {message} — retrying in {seconds}s',
    'run.tokenRejected': '{base}: the token does not fit, a new request is needed',
    'run.command': '{base}: {seq} {method} → {flag}',
    'run.ok': 'ok',
    'run.error': 'error {code}',
    'api.unauthorized': 'the token did not fit',
    'api.timeout': 'the server did not answer',
    'api.http': 'HTTP {status}',
    'bash.needCommand': 'command is required and must be a non-empty string',
    'bash.timeout': 'the command did not finish within {seconds}s and was killed',
    'bash.cancelled': 'the call was cancelled',
    'plugins.noName': '{label}: no api.name',
    'plugins.nameType': '{label}: api.name must be a string',
    'plugins.noMethods': '{label}: api.methods is empty',
    'plugins.noHandle': '{label}: no handle()',
    'plugins.methodNoName': '{label}: a method without a name',
    'plugins.methodNoArgs': '{label}: method {method} has no args schema',
    'plugins.directory': 'cannot read the plugins directory: {message}',
    'plugins.taken': 'plugin {entry} declares api "{name}", which is already taken — skipped',
    'plugins.failed': 'plugin {entry} did not load: {message}',
  },
  ru: {
    'auto.copyState': 'Перенести текущее состояние (токен, курсор) в {dir}? [y/N]',
    'auto.copied': 'Состояние перенесено: {dir}',
    'auto.copyFailed': 'Не удалось перенести состояние ({message}) — выполни `dshnc connect <ссылка>` от {user}',
    'auto.copySkip': 'Состояние оставляю здесь; новому пользователю понадобится `dshnc connect <ссылка>`',
    'help.autostart': 'autostart                вопросы и автозапуск через systemd',
    'unit.description': 'клиент dsh-nodes (dshnc) — исполнитель удалённых команд',
    'auto.title': 'Настройка автозапуска (systemd)',
    'auto.name': 'Имя узла',
    'auto.aliases': 'Алиасы через запятую (по любому из них узел можно позвать)',
    'auto.scope': 'Запускать системной службой [system] или внутри твоей сессии [user]',
    'auto.dedicated': 'Создать для него отдельного системного пользователя? [y/N]',
    'auto.username': 'Имя пользователя',
    'auto.createUser': 'Нет прав создавать пользователей. Выполни это и нажми Enter:',
    'auto.waitingUser': 'жду пользователя {user}…',
    'auto.graphical': 'Запускать только внутри графической сессии (нужен DISPLAY)? [y/N]',
    'auto.written': 'Юнит записан: {path}',
    'auto.next': 'Теперь от имени пользователя с правами:',
    'auto.stateDir': 'Состояние (токен, курсор) живёт в {dir}',
    'auto.copyConfig': 'Копирую существующее состояние в {dir}',
    'auto.noToken': 'Токена ещё нет: после установки выполни `sudo -u {user} dshnc connect <ссылка>`',
    'auto.done': 'Готово.',
    'bash.arg.stdin': 'Данные в stdin команды (до 64 КиБ)',
    'bash.api.description': 'Shell на машине узла',
    'bash.exec.description': 'Выполнить команду в shell и вернуть stdout, stderr и код возврата',
    'bash.arg.command': 'Командная строка',
    'bash.arg.cwd': 'Рабочий каталог',
    'bash.arg.timeout': 'Таймаут в секундах',
    'help.title': 'dshnc — клиент dsh-nodes ({home})',
    'help.connect': 'connect <url>            подключиться: ссылка с кодом связывает всё сама,',
    'help.connect2': '                         без кода — заявка и ожидание одобрения в админке',
    'help.daemon': 'daemon [url...]          работать: объявить bash, забирать команды, отвечать',
    'help.daemon2': '                         без аргументов — все серверы из конфига;',
    'help.daemon3': '                         работает на переднем плане (фон — через systemd/nohup)',
    'help.foreground': '--foreground             оставлено для совместимости, поведение то же',
    'help.status': 'status                   показать id клиента и сохранённые серверы',
    'help.help': 'help                     этот экран',
    'help.env': 'Переменные: DSHNC_HOME (каталог состояния), DSHNC_SHELL (шелл, по умолчанию /bin/sh), DSHNC_LANG (en, ru, zh)',
    'status.id': 'id клиента:  {id}',
    'status.name': 'имя:         {name}',
    'status.none': 'серверов нет — начни с `dshnc connect <url>`',
    'status.server': '{url}: {token}, курсор {cursor}, epoch {epoch}{alias}',
    'status.token.yes': 'токен есть',
    'status.token.no': 'токена нет',
    'status.alias': ', узел {alias}',
    'cmd.unknown': 'неизвестная команда: {command}',
    'err.needUrl': 'нужен url: dshnc connect https://host/dsh-nodes/pair?v=...',
    'err.nothingToServe': 'нечего обслуживать: сначала `dshnc connect <url>`',
    'err.generic': 'ошибка: {message}',
    'err.aborted': 'прервано',
    'connect.paired': 'подключено: узел {node} ({alias}), токен сохранён',
    'connect.requested': 'заявка отправлена: {name} / {short}',
    'connect.waiting': 'админ должен допустить её в {base}/admin — ждём',
    'connect.approved': 'допущен: узел {node} ({alias}), токен сохранён',
    'connect.rejected': 'заявку отклонили',
    'connect.handed': 'токен уже выдан; перевыпусти в админке',
    'connect.timeout': 'заявка не одобрена за 30 минут',
    'connect.done': 'готово. дальше: dshnc daemon',
    'connect.noCode': 'в ссылке нет кода — подключение не состоится',
    'daemon.servers': 'серверы: {servers}',
    'daemon.plugins': 'плагины: {plugins}',
    'daemon.stopping': 'останавливаюсь',
    'run.announced': '{base}: объявили {apis}, epoch {epoch}',
    'run.warning': 'предупреждение: {warning}',
    'run.reconnect': '{base}: сервер другой жизни (epoch {from} → {to}), курсор сброшен',
    'run.restarted': '{base}: сервер перезапущен (epoch {from} → {to}), курсор сброшен',
    'run.presenceClosed': '{base}: присутствие закрыто ({code}), работаю опросом',
    'run.retry': '{base}: {message} — повтор через {seconds} с',
    'run.tokenRejected': '{base}: токен не подошёл, нужна новая заявка',
    'run.command': '{base}: {seq} {method} → {flag}',
    'run.ok': 'ok',
    'run.error': 'ошибка {code}',
    'api.unauthorized': 'токен не подошёл',
    'api.timeout': 'сервер не ответил',
    'api.http': 'HTTP {status}',
    'bash.needCommand': 'command обязателен и должен быть непустой строкой',
    'bash.timeout': 'команда не уложилась в {seconds} с и была убита',
    'bash.cancelled': 'вызов отменён',
    'plugins.noName': '{label}: нет api.name',
    'plugins.nameType': '{label}: api.name должен быть строкой',
    'plugins.noMethods': '{label}: api.methods пуст',
    'plugins.noHandle': '{label}: нет handle()',
    'plugins.methodNoName': '{label}: метод без имени',
    'plugins.methodNoArgs': '{label}: метод {method} без схемы args',
    'plugins.directory': 'каталог плагинов не читается: {message}',
    'plugins.taken': 'плагин {entry} объявляет api «{name}», который уже занят — пропущен',
    'plugins.failed': 'плагин {entry} не загрузился: {message}',
  },
  zh: {
    'auto.copyState': '把当前状态（令牌、游标）搬到 {dir} 吗？[y/N]',
    'auto.copied': '状态已复制：{dir}',
    'auto.copyFailed': '无法复制状态（{message}）——请以 {user} 身份执行 `dshnc connect <链接>`',
    'auto.copySkip': '状态留在原处；新用户需要执行 `dshnc connect <链接>`',
    'help.autostart': 'autostart                几个问题，然后配置 systemd 自启',
    'unit.description': 'dsh-nodes 客户端（dshnc）——远程命令执行器',
    'auto.title': '配置开机自启（systemd）',
    'auto.name': '节点名称',
    'auto.aliases': '别名，用逗号分隔（任意一个都能叫到节点）',
    'auto.scope': '作为系统服务运行 [system] 还是在你自己的会话里 [user]',
    'auto.dedicated': '为它创建独立的系统用户？[y/N]',
    'auto.username': '用户名',
    'auto.createUser': '没有创建用户的权限。请执行下面的命令，完成后按 Enter：',
    'auto.waitingUser': '正在等待用户 {user}…',
    'auto.graphical': '仅在图形会话中启动（需要 DISPLAY）？[y/N]',
    'auto.written': '单元文件已写入：{path}',
    'auto.next': '现在用有权限的用户执行：',
    'auto.stateDir': '状态（令牌、游标）位于 {dir}',
    'auto.copyConfig': '正在把现有状态复制到 {dir}',
    'auto.noToken': '还没有令牌：安装后执行 `sudo -u {user} dshnc connect <链接>`',
    'auto.done': '完成。',
    'bash.arg.stdin': '传给命令 stdin 的数据（最多 64 KiB）',
    'bash.api.description': '节点机器上的 shell',
    'bash.exec.description': '在 shell 中执行命令，返回 stdout、stderr 和退出码',
    'bash.arg.command': '命令行',
    'bash.arg.cwd': '工作目录',
    'bash.arg.timeout': '超时时间（秒）',
    'help.title': 'dshnc — 客户端 dsh-nodes ({home})',
    'help.connect': 'connect <url>            连接：带验证码的链接会自己完成绑定，',
    'help.connect2': '                         没有验证码时——提交申请并在管理页等待批准',
    'help.daemon': 'daemon [url...]          运行：声明 bash，取命令，回结果',
    'help.daemon2': '                         不带参数时——配置文件里的所有服务器；',
    'help.daemon3': '                         前台运行（后台交给 systemd/nohup）',
    'help.foreground': '--foreground             保留兼容，行为相同',
    'help.status': 'status                   显示客户端 id 和已保存的服务器',
    'help.help': 'help                     这个界面',
    'help.env': '环境变量：DSHNC_HOME（状态目录）、DSHNC_SHELL（默认 /bin/sh）、DSHNC_LANG（en、ru、zh）',
    'status.id': '客户端 id：{id}',
    'status.name': '名称：      {name}',
    'status.none': '还没有服务器——先运行 `dshnc connect <url>`',
    'status.server': '{url}：{token}，游标 {cursor}，epoch {epoch}{alias}',
    'status.token.yes': '有令牌',
    'status.token.no': '没有令牌',
    'status.alias': '，节点 {alias}',
    'cmd.unknown': '未知命令：{command}',
    'err.needUrl': '需要 url：dshnc connect https://host/dsh-nodes/pair?v=...',
    'err.nothingToServe': '没有可服务的服务器：先运行 `dshnc connect <url>`',
    'err.generic': '错误：{message}',
    'err.aborted': '已中断',
    'connect.paired': '已连接：节点 {node}（{alias}），令牌已保存',
    'connect.requested': '申请已发送：{name} / {short}',
    'connect.waiting': '管理员需在 {base}/admin 批准——等待中',
    'connect.approved': '已批准：节点 {node}（{alias}），令牌已保存',
    'connect.rejected': '申请被拒绝',
    'connect.handed': '令牌已发出；请在管理页重新签发',
    'connect.timeout': '申请在 30 分钟内未获批准',
    'connect.done': '完成。下一步：dshnc daemon',
    'connect.noCode': '链接里没有验证码——无法连接',
    'daemon.servers': '服务器：{servers}',
    'daemon.plugins': '插件：{plugins}',
    'daemon.stopping': '正在停止',
    'run.announced': '{base}：已声明 {apis}，epoch {epoch}',
    'run.warning': '警告：{warning}',
    'run.reconnect': '{base}：服务器已换代（epoch {from} → {to}），游标已重置',
    'run.restarted': '{base}：服务器重启（epoch {from} → {to}），游标已重置',
    'run.presenceClosed': '{base}：连接已关闭（{code}），改用轮询',
    'run.retry': '{base}：{message}——{seconds} 秒后重试',
    'run.tokenRejected': '{base}：令牌不匹配，需要重新申请',
    'run.command': '{base}：{seq} {method} → {flag}',
    'run.ok': 'ok',
    'run.error': '错误 {code}',
    'api.unauthorized': '令牌不匹配',
    'api.timeout': '服务器没有响应',
    'api.http': 'HTTP {status}',
    'bash.needCommand': 'command 必填，且必须是非空字符串',
    'bash.timeout': '命令未在 {seconds} 秒内完成，已被终止',
    'bash.cancelled': '调用已取消',
    'plugins.noName': '{label}: 缺少 api.name',
    'plugins.nameType': '{label}: api.name 必须是字符串',
    'plugins.noMethods': '{label}: api.methods 为空',
    'plugins.noHandle': '{label}: 缺少 handle()',
    'plugins.methodNoName': '{label}: 有方法没有名字',
    'plugins.methodNoArgs': '{label}: 方法 {method} 没有 args 结构',
    'plugins.directory': '无法读取插件目录：{message}',
    'plugins.taken': '插件 {entry} 声明的 api“{name}”已被占用——跳过',
    'plugins.failed': '插件 {entry} 加载失败：{message}',
  },
}

/** Привести локаль к одному из поддерживаемых языков. */
export function normalizeLang (value) {
  if (!value) return null
  const tag = String(value).trim().toLowerCase().replace('_', '-')
  if (!tag) return null
  if (tag.startsWith('zh')) return 'zh'
  if (tag.startsWith('ru')) return 'ru'
  if (tag.startsWith('en')) return 'en'
  return null
}

/** Язык из окружения: DSHNC_LANG → LC_ALL → LC_MESSAGES → LANG → en. */
export function detectLang (env = process.env) {
  for (const key of ['DSHNC_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const lang = normalizeLang(env?.[key])
    if (lang) return lang
  }
  return 'en'
}

let current = 'en'

/** Зафиксировать язык для процесса. */
export function setLang (lang) {
  current = normalizeLang(lang) ?? 'en'
  return current
}

/** Текущий язык. */
export function lang () {
  return current
}

/**
 * Перевод по ключу с подстановкой `{name}`.
 * @param {string} key ключ словаря
 * @param {Record<string, unknown>} [vars]
 */
export function t (key, vars) {
  const table = DICT[current] ?? DICT.en
  const template = table[key] ?? DICT.en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
}

/** Для тестов: есть ли ключ во всех языках. */
export function keys () {
  return Object.keys(DICT.en)
}

/** Для тестов: словарь языка. */
export function table (lang) {
  return DICT[lang] ?? {}
}
