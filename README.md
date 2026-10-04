# AI-Тренер Backend

Минимальный Next.js проект, который обслуживает endpoint `/api/ai` для приложения AI-Тренер.
Использует `z-ai-web-dev-sdk` (без API-ключей — встроенная инфраструктура Z.ai).

## Что здесь

```
vercel-backend/
├── src/app/api/ai/route.ts   ← сам endpoint
├── package.json              ← зависимости (next + z-ai-web-dev-sdk)
├── next.config.js            ← CORS разрешён отовсюду (для APK)
├── tsconfig.json
├── vercel.json
└── .gitignore
```

## Как задеплоить на Vercel (бесплатно)

### Шаг 1. Залей проект на GitHub

1. Создай новый репо на GitHub, например `ai-trener-backend`
2. Залей содержимое этой папки:
   ```bash
   cd vercel-backend
   git init
   git add .
   git commit -m "AI-Тренер backend"
   git branch -M main
   git remote add origin https://github.com/ТВОЙ_ЛОГИН/ai-trener-backend.git
   git push -u origin main
   ```

### Шаг 2. Подключи к Vercel

1. Иди на https://vercel.com, залогинься через GitHub
2. Нажми **«Add New Project»** → выбери репо `ai-trener-backend`
3. Framework Preset: **Next.js** (определится автоматически)
4. Ничего не меняй в настройках — **Deploy**
5. Подожди 1-2 минуты, получишь URL вида:
   ```
   https://ai-trener-backend-xxxx.vercel.app
   ```

### Шаг 3. Проверь что работает

Открой в браузере:
```
https://ai-trener-backend-xxxx.vercel.app/api/ai
```
Должен вернуть JSON с ошибкой «Пустой запрос» — это значит endpoint жив.

Или проверь через curl:
```bash
curl -X POST https://ai-trener-backend-xxxx.vercel.app/api/ai \
  -H "Content-Type: application/json" \
  -d '{"message":"Привет","context":"Профиль не заполнен."}'
```

Должен вернуться ответ AI.

### Шаг 4. Пропиши URL в приложении

В приложении (HTML) на вкладке **Настройки** появится поле **«URL AI-сервера»**.
Вставь туда свой Vercel URL:
```
https://ai-trener-backend-xxxx.vercel.app
```
(без `/api/ai` в конце — приложение само подставит)

После этого AI-чат в APK будет работать на любом устройстве.

## Что важно знать

- **Vercel Free план**: 100 GB-часов в месяц на serverless functions. Для личного приложения и 2-3 друзей — хватит с огромным запасом.
- **CORS**: в `next.config.js` разрешены запросы отовсюду. Это нужно чтобы APK мог стучаться. Если хочешь ограничить — поменяй `Access-Control-Allow-Origin` на свой домен.
- **Без ключей**: z-ai-web-dev-sdk работает через встроенную инфраструктуру Z.ai, API-ключи не нужны.
- **Лимиты AI**: длинные ответы (полный 8-недельный план) могут занять 5-30 секунд. Vercel по умолчанию держит функцию живой до 10 секунд на free плане. Если нужно дольше — в `vercel.json` добавь `"functions": { "src/app/api/ai/route.ts": { "maxDuration": 60 } }`.

## Локальный запуск (для разработки)

```bash
cd vercel-backend
npm install
npm run dev
```
Откроется на http://localhost:3000. Endpoint: http://localhost:3000/api/ai

## Структура API

### POST /api/ai

**Request:**
```json
{
  "message": "Создай план тренировок на 8 недель",
  "context": "Профиль: масса, новичок, зал, 3 дня/нед...",
  "history": "User: ... Assistant: ..."
}
```

**Response (успех):**
```json
{
  "ok": true,
  "answer": "Создам план...",
  "actions": [
    { "type": "replace_plan", "plan": { ... } }
  ]
}
```

**Response (ошибка):**
```json
{ "ok": false, "error": "Ошибка AI: ..." }
```

## Действия (actions) которые AI может возвращать

- `replace_plan` — полностью заменить план (старый уходит в историю)
- `patch_plan` — изменить одно поле в блоке (например вес)
- `add_block` — добавить упражнение в день
- `remove_block` — удалить упражнение из дня

## Backup план если Vercel не подойдёт

- **Netlify Functions** — аналогично, бесплатно
- **Cloudflare Workers** — бесплатно до 100k запросов/день
- **Свой VPS** — любой хостинг с Node.js
