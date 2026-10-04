import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

// Кэшируем инстанс SDK между запросами — дорого создавать каждый раз
let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function getZai() {
  if (!zaiInstance) {
    zaiInstance = await ZAI.create();
  }
  return zaiInstance;
}

type Action =
  | { type: "replace_plan"; plan: PlanShape }
  | {
      type: "patch_plan";
      weekIndex: number;
      dayIndex: number;
      blockIndex: number;
      patch: Record<string, unknown>;
    }
  | { type: "add_block"; weekIndex: number; dayIndex: number; block: BlockShape }
  | { type: "remove_block"; weekIndex: number; dayIndex: number; blockIndex: number };

interface BlockShape {
  exerciseId: string;
  sets: number;
  reps: string;
  weightKg: number | null;
  restSec: number;
  note?: string;
}

interface DayShape {
  dayOfWeek: number; // 1=Пн ... 7=Вс
  title: string;
  blocks: BlockShape[];
}

interface PlanShape {
  title: string;
  durationWeeks: number;
  weeks: { weekNumber: number; note: string; days: DayShape[] }[];
  basis?: string;
}

// Системный промпт — задаёт роль, стиль и формат действий
const SYSTEM_PROMPT = `Ты — персональный AI-тренер в веб-приложении «AI-Тренер».
Твоя задача — помогать пользователю с тренировками, питанием, восстановлением и техникой.
Ты можешь не только давать советы текстом, но и НАПРЯМУЮ ИЗМЕНЯТЬ план пользователя.

=== ПРАВИЛА ОТВЕТА ===
1. Отвечай на русском языке.
2. Будь конкретен. Не «нужно увеличить белок», а «добавь 30 г творога на завтрак — это +5 г белка».
3. Длина обычного ответа — 3-6 предложений. Списки только если это реально нужно.
4. Учитывай контекст пользователя (цель, уровень, оборудование, травмы, текущий план, последние логи).
5. Если у пользователя травма — никогда не советуй и не вставляй в план упражнения, нагружающие эту зону. Если не уверен — уточни.
6. Если вопрос не про фитнес/здоровье — вежливо верни тему к тренировкам.
7. Не выдумывай упражнения — используй ТОЛЬКО exerciseId из списка доступных, который придёт в контексте.
8. Не пиши disclaimer'ы про «проконсультируйтесь с врачом».

=== КОГДА СОЗДАВАТЬ ПЛАН ===
Если у пользователя ещё нет плана (это будет явно указано в контексте), либо если он просит создать новый план:

1. ПРОВЕРЬ КОНТЕКСТ. Если в нём уже указаны дни недели, длительность тренировки и цель — НЕ задавай уточняющие вопросы, сразу переходи к созданию плана. Задавай уточняющие вопросы ТОЛЬКО если в контексте этих данных нет (например, профиль пустой или не заполнен days/mins).
2. СОЗДАВАЙ ПЛАН ТОЛЬКО НА 1 НЕДЕЛЮ КАК ШАБЛОН. Это критично важно. В weeks передай только ОДНУ неделю (weekNumber:1). Приложение само развернёт её в 8 недель с прогрессией (deload на 4-й, +2.5 кг на 5-7). durationWeeks:8, weeks.length:1.
3. В шаблонной неделе должно быть столько дней, сколько указано в профиле (если days=3 — то 3 дня).
4. Структура шаблонной недели (неделя 1, стартовая):
   - Лёгкие веса (запас 2-3 повтора до отказа)
   - 4 упражнения на тренировку, 3-4 подхода
   - reps в формате "10-12" (строка)
   - note="" пустой для всех блоков
5. Возвращай план через replace_plan action.
6. Будь МАКСИМАЛЬНО ЛАКОНИЧНЫМ:
   - Текстовый ответ перед блоком actions — 1 предложение максимум.
   - note="" пустой для ВСЕХ блоков, не вставляй туда текст.
   - 4 упражнения на тренировку, не больше.
   - reps всегда в формате "10-12" (строкой).

=== КОГДА КОРРЕКТИРОВАТЬ ПЛАН ===
Если у пользователя уже есть план, и он просит что-то поменять — используй patch_plan, add_block или remove_block.
Также: после тренировок с логами, где пользователь явно легко выполнил все повторения на верхней границе, можешь предложить +2.5 кг к этому упражнению через patch_plan.

=== ФОРМАТ ДЕЙСТВИЙ ===
Если нужно изменить план — добавь в КОНЕЦ обычного текстового ответа блок в формате:

\`\`\`actions
{"actions":[{"type":"replace_plan","plan":{...}}]}
\`\`\`

или:

\`\`\`actions
{"actions":[{"type":"patch_plan","weekIndex":0,"dayIndex":1,"blockIndex":0,"patch":{"weightKg":70}}]}
\`\`\`

ВАЖНО:
- Индексы: weekIndex (0-7), dayIndex (0-based в пределах weeks[weekIndex].days), blockIndex (0-based в пределах day.blocks).
- exerciseId обязан быть из списка доступных в контексте.
- Если действие не нужно — НЕ добавляй блок actions, просто отвечай текстом.
- Если вопрос пользователя требует уточнения — НЕ создавай план, а задай вопрос. Действие только когда у тебя достаточно информации.

=== СТРУКТУРА ПЛАНА (replace_plan) ===
{
  "title": "Масса — 8 недель, 3 дня",
  "durationWeeks": 8,
  "weeks": [
    {
      "weekNumber": 1,
      "note": "Стартовая неделя. Записывай фактические веса.",
      "days": [
        {
          "dayOfWeek": 1,
          "title": "Фулбоди А",
          "blocks": [
            {"exerciseId":"smith_squat","sets":3,"reps":"10-12","weightKg":65,"restSec":90,"note":""},
            {"exerciseId":"plank","sets":3,"reps":"30-45 сек","weightKg":null,"restSec":60,"note":""}
          ]
        }
      ]
    }
  ],
  "basis":"Создан AI на основе диалога и анкеты пользователя"
}

=== ТИПЫ ДЕЙСТВИЙ ===
- replace_plan — полностью заменить план (старый уходит в историю)
- patch_plan — изменить одно поле в блоке (например weightKg). patch — объект с теми полями, которые надо заменить
- add_block — добавить упражнение в день
- remove_block — удалить упражнение из дня

Контекст пользователя (если есть) будет передан отдельным сообщением перед вопросом.`;

interface ParsedActions {
  cleanText: string;
  actions: Action[];
}

// Чиним частые ошибки LLM в JSON:
//  1) "reps":30-45 сек  →  "reps":"30-45 сек"
//  2) "reps":10         →  "reps":"10"
//  3) Дисбаланс скобок — авто-балансировка
function fixJsonString(raw: string): string {
  let out = raw;
  // 1) диапазоны с единицами измерения
  out = out.replace(
    /"(reps|note)":\s*(\d+\s*-\s*\d+\s*[а-яА-Яa-zA-Z\s]*)/g,
    (_m, key: string, val: string) => `"${key}":"${val.trim()}"`
  );
  // 2) bare number → string (только для reps)
  out = out.replace(
    /"reps":\s*(\d+(?:\s*-\s*\d+)?)\s*([,}])/g,
    (_m, val: string, sep: string) => `"reps":"${val}"${sep}`
  );
  // 3) Балансировка скобок — считаем и обрезаем/добавляем с конца
  function countBalance(s: string): { braces: number; brackets: number } {
    let ob = 0,
      obk = 0,
      ins = false,
      esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        ins = !ins;
        continue;
      }
      if (ins) continue;
      if (ch === "{") ob++;
      else if (ch === "}") ob--;
      else if (ch === "[") obk++;
      else if (ch === "]") obk--;
    }
    return { braces: ob, brackets: obk };
  }

  const bal = countBalance(out);
  if (bal.braces < 0 || bal.brackets < 0) {
    // Лишние закрывающие — обрезаем с конца
    let toTrim = -bal.braces + -bal.brackets;
    let end = out.length;
    while (toTrim > 0 && end > 0) {
      const ch = out[end - 1];
      if (ch === "}" || ch === "]") {
        end--;
        toTrim--;
      } else if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
        end--;
      } else {
        break;
      }
    }
    out = out.substring(0, end);
  }
  if (bal.braces > 0 || bal.brackets > 0) {
    out =
      out +
      "]".repeat(Math.max(0, bal.brackets)) +
      "}".repeat(Math.max(0, bal.braces));
  }
  return out;
}

// Парсер action-блоков из ответа AI
function parseActions(raw: string): ParsedActions {
  // Ищем блок ```actions ... ``` — толерантно к whitespace и переносу строк
  const re = /```actions\s*?\n?([\s\S]*?)```/g;
  const actions: Action[] = [];
  let cleanText = raw;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const fixed = fixJsonString(match[1]);
    // Пробуем несколько стратегий парсинга — от простого к агрессивному
    const parsed = tryParseActionsJson(fixed);
    if (Array.isArray(parsed?.actions)) {
      for (const a of parsed.actions) {
        if (a && typeof a === "object" && typeof a.type === "string") {
          actions.push(a as Action);
        }
      }
    }
  }
  if (actions.length) {
    cleanText = raw.replace(re, "").trim();
  }
  return { cleanText, actions };
}

// Пытается распарсить JSON с actions — пробует несколько стратегий:
//  1) прямой parse
//  2) итеративно удаляем одну лишнюю } или ] в середине и пробуем снова
function tryParseActionsJson(s: string): { actions: unknown[] } | null {
  // Стратегия 1: прямой парс
  try {
    const p = JSON.parse(s);
    if (Array.isArray(p?.actions)) return p;
  } catch {
    // продолжаем
  }
  // Стратегия 2: находим все позиции где есть `}}` или `]]` (двойные)
  // и пробуем удалить одну из них
  const candidates: string[] = [];
  for (let i = 0; i < s.length - 1 && candidates.length < 30; i++) {
    if (s[i] === "}" && s[i + 1] === "}") {
      candidates.push(s.substring(0, i + 1) + s.substring(i + 2));
    }
    if (s[i] === "]" && s[i + 1] === "]") {
      candidates.push(s.substring(0, i + 1) + s.substring(i + 2));
    }
  }
  for (const c of candidates) {
    try {
      const p = JSON.parse(c);
      if (Array.isArray(p?.actions)) return p;
    } catch {
      // продолжаем
    }
  }
  // Стратегия 3: перебираем все позиции ] и } — пробуем удалять по одной
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "]") {
      const c = s.substring(0, i) + s.substring(i + 1);
      try {
        const p = JSON.parse(c);
        if (Array.isArray(p?.actions)) return p;
      } catch {
        // продолжаем
      }
    }
    if (s[i] === "}") {
      const c = s.substring(0, i) + s.substring(i + 1);
      try {
        const p = JSON.parse(c);
        if (Array.isArray(p?.actions)) return p;
      } catch {
        // продолжаем
      }
    }
  }
  // Стратегия 4: добавляем недостающие ] или } в конец
  const bal = countBalance(s);
  if (bal.brackets > 0) {
    const added = s + "]".repeat(bal.brackets);
    try {
      const p = JSON.parse(added);
      if (Array.isArray(p?.actions)) return p;
    } catch {
      // продолжаем
    }
  }
  if (bal.braces > 0) {
    const added = s + "}".repeat(bal.braces);
    try {
      const p = JSON.parse(added);
      if (Array.isArray(p?.actions)) return p;
    } catch {
      // продолжаем
    }
  }
  return null;
}

function countBalance(s: string): { braces: number; brackets: number } {
  let ob = 0,
    obk = 0,
    ins = false,
    esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      ins = !ins;
      continue;
    }
    if (ins) continue;
    if (ch === "{") ob++;
    else if (ch === "}") ob--;
    else if (ch === "[") obk++;
    else if (ch === "]") obk--;
  }
  return { braces: ob, brackets: obk };
}

// Минимальная валидация плана — чтобы не положить приложение битым JSON
function isValidPlan(p: unknown): p is PlanShape {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (typeof o.title !== "string") return false;
  if (typeof o.durationWeeks !== "number") return false;
  if (!Array.isArray(o.weeks)) return false;
  for (const w of o.weeks as unknown[]) {
    if (!w || typeof w !== "object") return false;
    const wObj = w as Record<string, unknown>;
    if (typeof wObj.weekNumber !== "number") return false;
    if (typeof wObj.note !== "string") return false;
    if (!Array.isArray(wObj.days)) return false;
    for (const d of wObj.days as unknown[]) {
      if (!d || typeof d !== "object") return false;
      const dObj = d as Record<string, unknown>;
      if (typeof dObj.dayOfWeek !== "number") return false;
      if (typeof dObj.title !== "string") return false;
      if (!Array.isArray(dObj.blocks)) return false;
      for (const b of dObj.blocks as unknown[]) {
        if (!b || typeof b !== "object") return false;
        const bObj = b as Record<string, unknown>;
        if (typeof bObj.exerciseId !== "string") return false;
        if (typeof bObj.sets !== "number") return false;
        if (typeof bObj.reps !== "string") return false;
        if (bObj.weightKg !== null && typeof bObj.weightKg !== "number") return false;
        if (typeof bObj.restSec !== "number") return false;
      }
    }
  }
  return true;
}

function sanitizeActions(actions: Action[]): Action[] {
  const out: Action[] = [];
  for (const a of actions) {
    if (a.type === "replace_plan") {
      if (isValidPlan(a.plan)) {
        // Добавляем createdAt если нет
        const plan = a.plan as PlanShape & { createdAt?: string };
        if (!plan.createdAt) plan.createdAt = new Date().toISOString();
        out.push({ type: "replace_plan", plan });
      }
    } else if (a.type === "patch_plan") {
      if (
        typeof a.weekIndex === "number" &&
        typeof a.dayIndex === "number" &&
        typeof a.blockIndex === "number" &&
        a.patch &&
        typeof a.patch === "object"
      ) {
        out.push(a);
      }
    } else if (a.type === "add_block") {
      if (
        typeof a.weekIndex === "number" &&
        typeof a.dayIndex === "number" &&
        a.block &&
        typeof a.block.exerciseId === "string"
      ) {
        out.push(a);
      }
    } else if (a.type === "remove_block") {
      if (
        typeof a.weekIndex === "number" &&
        typeof a.dayIndex === "number" &&
        typeof a.blockIndex === "number"
      ) {
        out.push(a);
      }
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const message: string = (body.message || "").toString().trim();
    const context: string = (body.context || "").toString().trim();
    const history: string = (body.history || "").toString().trim();

    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Пустой запрос" },
        { status: 400 }
      );
    }
    if (message.length > 2000) {
      return NextResponse.json(
        { ok: false, error: "Сообщение слишком длинное (макс 2000 символов)" },
        { status: 400 }
      );
    }

    const zai = await getZai();

    const messages: { role: "assistant" | "user"; content: string }[] = [
      { role: "assistant", content: SYSTEM_PROMPT },
    ];

    if (context) {
      messages.push({
        role: "assistant",
        content:
          "Вот текущий контекст пользователя из приложения. Учитывай его при ответе:\n\n" +
          context,
      });
    }

    // Если есть история диалога — добавляем её как assistant note, чтобы AI помнил контекст
    if (history) {
      messages.push({
        role: "assistant",
        content:
          "Вот предыдущая история диалога (последние сообщения). Используй её, чтобы не задавать уточняющие вопросы повторно:\n\n" +
          history,
      });
    }

    messages.push({ role: "user", content: message });

    const completion = await zai.chat.completions.create({
      messages,
      thinking: { type: "disabled" },
      max_tokens: 16000,
    } as Record<string, unknown>);

    let rawAnswer = completion.choices?.[0]?.message?.content?.trim() || "";

    // Если AI обрезал ответ (force recompile) на блоке actions — продолжаем генерацию.
    // Проверяем: есть ли ```actions в ответе, и есть ли после него закрывающий ```
    function hasUnclosedActionsBlock(text: string): boolean {
      const startIdx = text.indexOf("```actions");
      if (startIdx < 0) return false;
      const after = text.slice(startIdx + "```actions".length);
      return !after.includes("```");
    }

    let continuationTries = 0;
    while (continuationTries < 3 && hasUnclosedActionsBlock(rawAnswer)) {
      continuationTries++;
      const continueMessages: { role: "assistant" | "user"; content: string }[] = [
        ...messages,
        { role: "assistant", content: rawAnswer },
        {
          role: "user",
          content:
            "Продолжи свой ответ с того места, где остановился. Не повторяй уже написанное, просто допиши окончание JSON-блока действий и закрой его тремя обратными кавычками (```)",
        },
      ];
      try {
        const cont = await zai.chat.completions.create({
          messages: continueMessages,
          thinking: { type: "disabled" },
          max_tokens: 16000,
        } as Record<string, unknown>);
        const contText = cont.choices?.[0]?.message?.content?.trim() || "";
        if (contText) {
          rawAnswer = rawAnswer + contText;
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    if (!rawAnswer) {
      return NextResponse.json(
        { ok: false, error: "AI вернул пустой ответ" },
        { status: 502 }
      );
    }

    // Парсим actions из ответа
    const { cleanText, actions } = parseActions(rawAnswer);
    const sanitized = sanitizeActions(actions);

    return NextResponse.json({
      ok: true,
      answer: cleanText,
      actions: sanitized,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/ai] error:", msg);
    return NextResponse.json(
      { ok: false, error: "Ошибка AI: " + msg },
      { status: 500 }
    );
  }
}

export const dynamic = "force-dynamic";
// touched at Sun Oct  4 19:15:27 UTC 2026
