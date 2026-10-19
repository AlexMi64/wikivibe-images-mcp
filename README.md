# wikivibe-images-mcp

MCP-сервер для генерации и редактирования изображений через [WikiVibe](https://wikivibe.ru).
Работает в любом агенте с поддержкой MCP: **OMP**, **Codex CLI**, **Claude Code**, **Cursor**,
**opencode/Orca**.

Поставил → сказал «сделай картинку через wikivibe» → получил файл.

```
┌──────────────┐
│ OMP          │─┐
│ Codex CLI    │─┤   stdio    ┌───────────────┐   HTTPS   ┌──────────────────┐
│ Claude Code  │─┼───────────▶│wikivibe-images│──────────▶│ api.wikivibe.ru  │
│ Cursor       │─┤            │  (один бинарь)│           │ /images/…        │
│ opencode     │─┘            └───────┬───────┘           └──────────────────┘
└──────────────┘                      │
                              ~/.wikivibe/credentials.json (0600)
```

## Быстрый старт

```bash
npx -y wikivibe-images-mcp login        # сохранить ключ (один раз)
npx -y wikivibe-images-mcp setup all    # прописать сервер во все найденные агенты
```

Перезапустить агент и попросить:

> сделай картинку через wikivibe: рыжий кот в космическом шлеме, фотореализм

Агент вызовет `generate_image`, получит путь к файлу и сам покажет картинку.

`setup` без аргументов или с `all` обходит все клиенты; можно указать выборочно:

```bash
npx -y wikivibe-images-mcp setup omp codex
```

Доступные имена: `omp`, `claude`, `codex`, `cursor`, `opencode` (она же `orca`).

## Ручная настройка

Если не хотите запускать `setup`, добавьте сервер сами.

**OMP** — `~/.omp/agent/mcp.json`:

```json
{
  "mcpServers": {
    "wikivibe": {
      "command": "npx",
      "args": ["-y", "wikivibe-images-mcp", "mcp"],
      "timeout": 300000
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.wikivibe]
command = "npx"
args = ["-y", "wikivibe-images-mcp", "mcp"]
tool_timeout_sec = 300
```

**Claude Code**:

```bash
claude mcp add --scope user wikivibe -- npx -y wikivibe-images-mcp mcp
```

**Cursor** — `~/.cursor/mcp.json`: тот же JSON, что и для OMP.

**opencode / Orca** — `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "wikivibe": {
      "type": "local",
      "command": ["npx", "-y", "wikivibe-images-mcp", "mcp"],
      "enabled": true
    }
  }
}
```

> Таймауты. Генерация одной картинки занимает 25–45 секунд. Клиенты по умолчанию рубают
> MCP-вызов раньше, поэтому в OMP нужен `"timeout": 300000`, в Codex — `tool_timeout_sec = 300`,
> в Claude Code — переменная `MCP_TOOL_TIMEOUT=300000` в окружении.

## Инструменты

| Инструмент | Параметры | Что делает |
|---|---|---|
| `generate_image` | `prompt` или `prompts[]`, `n`, `model`, `size`, `quality`, `output_path` | создаёт изображения по тексту |
| `edit_image` | `prompt`, `images[]`, `n`, `model`, `size`, `quality`, `output_path` | правит локальные файлы (inpainting, restyle, замена объектов) |
| `list_image_models` | — | какие image-модели доступны ключу |

Каждый результат: путь к файлу на диске **и** сам файл как MCP image-блок — картинку видно
и в агентах без доступа к файловой системе.

### Несколько картинок за один вызов

```jsonc
// варианты одного промпта
{ "prompt": "керамическая чашка, продуктовое фото", "n": 3 }

// разные картинки
{ "prompts": ["лиса акварелью", "кит акварелью", "сова акварелью"] }
```

Максимум **4 изображения за вызов**. Запросы идут строго последовательно: API WikiVibe
не принимает `n > 1` для `gpt-image-*`, а параллельные вызовы роняют апстрим в 502.
Время растёт линейно — примерно 25–45 секунд на картинку.

## Ключ API

Ключ хранится **только** в `~/.wikivibe/credentials.json` (права `0600`, каталог `0700`).
В конфиги агентов он не попадает — там лишь команда запуска.

```bash
npx -y wikivibe-images-mcp login          # интерактивно, ввод скрыт
npx -y wikivibe-images-mcp login --key sk-…   # для CI
npx -y wikivibe-images-mcp import         # подхватить WIKIVIBE_API_KEY из ~/.omp/.env или ./.env
npx -y wikivibe-images-mcp status         # проверить ключ, base URL и доступные модели
```

Приоритет источников: `WIKIVIBE_API_KEY` → `~/.wikivibe/credentials.json`.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `WIKIVIBE_API_KEY` | ключ, переопределяет сохранённый |
| `WIKIVIBE_BASE_URL` | по умолчанию `https://api.wikivibe.ru/v1` |
| `WIKIVIBE_IMAGE_MODEL` | модель по умолчанию (сейчас `gpt-image-2.5`) |
| `WIKIVIBE_OUTPUT_DIR` | куда складывать файлы (по умолчанию системный temp) |
| `WIKIVIBE_CONFIG_DIR` | где лежит `credentials.json` |

## CLI без агента

```bash
npx -y wikivibe-images-mcp image "постер: закат над морем, минимализм"
npx -y wikivibe-images-mcp models
```

## Ошибки

| Что видно | Причина и что делать |
|---|---|
| `401` / `Unauthorized` | ключ неверный или отозван → `wikivibe login` |
| `403 image generation is disabled for this group` | у группы ключа выключен `allow_image_generation` → включить в кабинете WikiVibe |
| `400 unknown_parameter: 'tools[0].n'` | апстрим не принимает `n > 1`; сервер сам разбивает на последовательные запросы — обновите версию |
| `502` / `503` | перегружен апстрим-провайдер; клиент делает одну повторную попытку через 12 с. Не запускайте несколько генераций параллельно |
| клиент оборвал вызов по таймауту | поднимите лимит MCP: `timeout` в OMP, `tool_timeout_sec` в Codex, `MCP_TOOL_TIMEOUT` в Claude Code |

## Разработка

Нужен Node.js 20+.

```bash
npm install
npm run typecheck
npm run build      # esbuild → dist/cli.js, самодостаточный бандл
node dist/cli.js status
```

Проверка MCP-протокола вручную:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/cli.js mcp
```

Структура:

| Файл | Роль |
|---|---|
| `src/cli.ts` | команды `login` / `status` / `setup` / `image`, запуск сервера |
| `src/server.ts` | регистрация MCP-инструментов и схем |
| `src/images.ts` | генерация, редактирование, сохранение файлов |
| `src/api.ts` | HTTP-клиент: очередь, backoff, разбор ошибок |
| `src/credentials.ts` | хранение и поиск ключа |

## Лицензия

MIT
