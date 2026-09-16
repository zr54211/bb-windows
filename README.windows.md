# bb для Windows

Сборка предназначена для Windows x64 без WSL. Она запускает веб-интерфейс, сервер и host-daemon. Установщик Electron-приложения в неё не входит.

<a id="install"></a>
## Установка

Установите Git, PowerShell 7 и Node.js 22.19 или новее. Используйте закреплённую в репозитории версию pnpm. Выполняйте команды в PowerShell 7:

```powershell
npm install --global pnpm@9.15.0
git clone https://github.com/zr54211/bb-windows.git bb-windows
cd bb-windows
pwsh -NoProfile -File scripts/windows/check.ps1
pwsh -NoProfile -File scripts/windows/install.ps1
```

Для нативных зависимостей используются готовые бинарные пакеты, если они доступны. Если для выбранной версии Node нет подходящей сборки, потребуются инструменты сборки C++ для Windows и Python. Ошибка установки зависимости останавливает установку bb.

Собирайте остановленный экземпляр. Если bb уже работает из этой папки, используйте отдельную копию исходников для проверки новой сборки.

<a id="start-and-stop"></a>
## Запуск, остановка и порты

```powershell
pwsh -NoProfile -File scripts/windows/bb.ps1 -Action Start
pwsh -NoProfile -File scripts/windows/bb.ps1 -Action Status
pwsh -NoProfile -File scripts/windows/bb.ps1 -Action Stop
```

После запуска откройте **http://127.0.0.1:38886**. Порт host-daemon — **38887**.

| Вариант запуска | Сервер | Host-daemon |
| --- | --- | --- |
| Публичный Windows-скрипт без дополнительных параметров | 38886 | 38887 |
| Прежний локальный экспериментальный launcher | 48886 | 48887 |
| Изолированная проверка запуска и восстановления | 49886 | 49887 |

Если старый локальный экземпляр открывается на 48886, он продолжает работать с прежними параметрами. Публикация исходников не меняет порт уже запущенного процесса. Значения в инструкции относятся к новому Windows-скрипту.

Для явно заданных портов:

```powershell
pwsh -NoProfile -File scripts/windows/bb.ps1 -Action Start -ServerPort 48886 -DaemonPort 48887
```

Не запускайте второй экземпляр поверх занятого порта. Для отдельного экземпляра задайте также собственный `-DataDir`.

Launcher работает скрыто. Именованный Windows mutex предотвращает повторный запуск supervisor для одного каталога данных. bb восстанавливает сервер и daemon после завершения их процессов; внешний supervisor перезапускает упавший runtime. Windows Job Object удерживает дочерние процессы в одной группе. Остановка сначала штатная; через 20 секунд оставшиеся процессы этой группы завершаются принудительно.

Логи и база по умолчанию находятся в `%LOCALAPPDATA%\BBWindows`, вне репозитория. `Status` показывает наличие supervisor, а не состояние провайдеров. Supervisor не устанавливается как Windows-служба или задача автозапуска.

При `Start`, `Stop`, `Status`, установке и обновлении указывайте один и тот же `-DataDir`. Вместо него можно задать `BB_WINDOWS_DATA_DIR`.

Доступ по умолчанию разрешён только с локального компьютера. Параметр `-Lan` открывает сервер на всех IPv4-интерфейсах, но не настраивает авторизацию, TLS или брандмауэр. Настройте защиту доступа отдельно до включения LAN. Личные сертификаты, правила брандмауэра и прокси в сборку не входят.

## Командная строка bb

Управление службами выполняется через `bb.ps1`. Для команд bb используйте отдельный CLI:

```powershell
& .\apps\host-daemon\dist\bb.cmd --help
$env:PATH = (Join-Path $PWD 'apps/host-daemon/dist') + ';' + $env:PATH
bb status --json
```

При нестандартных портах задайте адреса и для CLI в текущем окне PowerShell:

```powershell
$env:BB_SERVER_URL = 'http://127.0.0.1:48886'
$env:BB_HOST_DAEMON_PORT = '48887'
bb status --json
```

Для стандартного запуска используйте 38886 и 38887. Установщик не меняет постоянный PATH пользователя.

<a id="providers-and-credentials"></a>
## Провайдеры и авторизация

Каждый пользователь самостоятельно авторизует Codex и Claude Code. OpenCode и DeepSeek Harness устанавливаются отдельно; для них нужно настроить используемые модели DeepSeek.

```powershell
pwsh -NoProfile -File scripts/windows/check.ps1 -Providers
bb provider list --json
bb provider models <id> --machine <id> --json
```

В командах замените `<id>` на идентификатор провайдера или машины. Проверка зависимостей проверяет наличие команд, но не авторизацию и не ответ модели. Выбирайте модели из каталога, который вернул ваш компьютер.

Launcher сам находит исполняемые файлы Codex и Claude Code. Node не запускает обёртки `.cmd` напрямую, поэтому наличия команды `codex` в PATH недостаточно: launcher добавляет в PATH каталог настоящего `codex.exe` из платформенного пакета `@openai/codex-win32-x64`. Claude Code передаётся через `BB_CLAUDE_CODE_EXECUTABLE`, потому что встроенный поиск нативного файла на Windows его не находит; заданное вами значение этой переменной сохраняется. Найденные пути launcher записывает в `windows-supervisor.log`, а `check.ps1 -Providers` показывает их в колонке `Executable`. Если колонка пуста, а команда есть в PATH, провайдер установлен так, что bb его не запустит.

В реальной проверке использовались Codex 0.153.4, Claude Code 2.1.270, OpenCode 1.18.30 и DeepSeek Harness 0.1.5-rc.1. Проверенные npm-компоненты можно установить так:

```powershell
npm install --global @openai/codex@0.153.4 opencode-ai@1.18.30 @deepseek-ai/dsh@0.1.5-rc.1
```

Claude Code проверялся через нативный исполняемый файл. Установка программы не выполняет вход в аккаунт.

[Пример переменных окружения](scripts/windows/.env.example) не содержит секретов. Скопируйте его в личный файл **вне Git** и передайте launcher параметр `-EnvFile <путь>`. Node загружает значения без их печати. Уже заданные переменные окружения имеют приоритет перед файлом.

Harness получает `DEEPSEEK_API_KEY` из окружения и ищет `dsh.cmd` в PATH. Через `BB_DEEPSEEK_HARNESS_EXECUTABLE` можно задать другой путь. OpenCode использует собственную локальную авторизацию; `BB_OPENCODE_EXECUTABLE` задаёт его исполняемый файл. В переменных путей указывайте файл программы, а не строку shell-команды.

<a id="zcode--glm"></a>
## ZCode / GLM

Нужны нативный CLI ZCode с вашей авторизацией, Rust/Cargo и инструменты линковки для Windows. Подготовьте адаптер на закреплённом коммите:

```powershell
git clone https://github.com/jpalmae/zcode-acp .runtime/zcode-acp
git -C .runtime/zcode-acp checkout 42fe149d4b501469343c01f23ba3801832306d53
$patch = Join-Path $PWD 'scripts/patches/zcode-acp-windows.patch'
git -C .runtime/zcode-acp apply $patch
pwsh -File scripts/build-zcode-light.ps1
```

После запуска bb и добавления CLI в PATH настройте новый список пользовательских ACP-агентов:

```powershell
$agent = @{
  id = 'zcode'
  displayName = 'ZCode'
  command = (Resolve-Path .runtime/zcode-acp/target/debug/zcode-acp.exe).Path
  args = @()
  env = @{
    ZCODE_ACP_ZCODE_PATH = Join-Path $env:ProgramFiles 'ZCode/resources/glm/zcode.cjs'
    ZCODE_ACP_CONFIG_PATH = Join-Path $env:USERPROFILE '.zcode/cli/config.json'
    ZCODE_ACP_MODEL = 'zai/glm-5.3'
  }
}
bb plugin config provider-acp set customAgents (ConvertTo-Json -InputObject @($agent) -Depth 4 -Compress)
bb plugin reload
```

Если ZCode установлен в другой каталог, измените путь к CLI. Команда заменяет **весь** список `customAgents`; при существующей настройке объедините запись с другими агентами. Не копируйте чужой файл авторизации ZCode.

Адаптер экспериментальный и закреплён на конкретной версии. Обновление ZCode требует повторной проверки совместимости. [Модели, изображения, отмена и ограничения](docs/windows-zcode.md).

<a id="selected-distribution"></a>
## Состав сборки

Включены PC Control, Workspace Explorer, Windows Screen, Git Graph и Monaco с предпросмотром Markdown, основные провайдеры и служебные плагины. Сохранена встроенная нижняя плашка лимитов.

Не переносите в распространяемую сборку существующую базу или каталог установленных плагинов.

Сохранены темы и профили типографики. Inter, Golos Text и JetBrains Mono поставляются закреплёнными пакетами fontsource. Fact, Frutiger, Crassula, Magistral и PT Mono включены в сборку как TTF и загружаются браузером; отдельная установка этих шрифтов в Windows не нужна.

<a id="verify"></a>
## Проверки

В подготовленной изолированной копии исходников:

```powershell
pnpm exec turbo run test:windows:lifecycle
pwsh -NoProfile -File scripts/windows/smoke-providers.ps1 -Project <SMOKE_PROJECT_ID>
```

Замените `<SMOKE_PROJECT_ID>` на идентификатор тестового проекта. Проверка жизненного цикла использует отдельные временные данные и порты 49886/49887: конкурентный запуск, падение сервера, daemon и runtime, восстановление, остановка и повторный запуск. Завершаются только процессы с подтверждённой принадлежностью тесту. Путь к логам печатается в конце.

Проверка провайдеров создаёт реальные треды через Codex, Claude, ZCode, DeepSeek/OpenCode и DeepSeek/Harness и расходует их квоту. В личной копии `scripts/windows/providers.example.json` можно закрепить идентификаторы моделей из актуального каталога.

Ответ через CLI не доказывает доставку в открытое окно. Отдельно проверьте появление ответа в браузере без обновления страницы и работу выбранных плагинов.

<a id="update-and-integrate-upstream"></a>
## Обновление и синхронизация с upstream

Пользователи обновляются из этого форка:

```powershell
pwsh -NoProfile -File scripts/windows/update.ps1 -Remote origin -Branch main
pwsh -NoProfile -File scripts/windows/bb.ps1 -Action Start
```

Обновление требует чистого Git-дерева и перехода fast-forward. Скрипт сначала получает изменения, затем останавливает выбранный экземпляр, применяет их и собирает bb. При ошибке подготовки bb остаётся остановленным.

При повторном запуске сохраните свои `-DataDir`, порты, `-Lan` и `-EnvFile`. Перед обновлением с миграциями БД сделайте копию остановленного каталога данных: откат кода сам по себе не отменяет миграцию.

Разработчики объединяют изменения upstream в отдельной ветке. Если remote `upstream` ещё не добавлен, выполните один раз:

```powershell
git remote add upstream https://github.com/get-bb/bb.git
```

Затем:

```powershell
git fetch upstream main
git switch -c integrate/upstream-YYYY-MM-DD
git merge --no-ff upstream/main
```

Замените `YYYY-MM-DD` на дату. Разрешите конфликты, проверьте версию протокола daemon и миграции, выполните сборку, тесты и Windows-приёмку. После проверки объедините интеграционную ветку с веткой форка. Не переписывайте общую историю и не используйте force push.
