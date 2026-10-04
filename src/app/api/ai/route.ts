// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import fs from "fs";
import os from "os";
import path from "path";

let zaiInstance = null;

function parseConfigFromEnvOrFile() {
  const envConfig = process.env.Z_AI_CONFIG;
  if (envConfig) {
    // Vercel иногда экранирует кавычки в env-переменных, что ломает JSON.parse.
    // Пробуем несколько стратегий парсинга.
    let c = null;

    // Попытка 1: как есть
    try { c = JSON.parse(envConfig); } catch (e) {}

    // Попытка 2: если есть escaped кавычки \" — делаем unescape
    if (!c && envConfig.indexOf('\\"') >= 0) {
      try { c = JSON.parse(envConfig.replace(/\\"/g, '"')); } catch (e) {}
    }

    // Попытка 3: берём подстроку от первого { до последнего }, потом unescape
    if (!c) {
      const first = envConfig.indexOf('{');
      const last = envConfig.lastIndexOf('}');
      if (first >= 0 && last > first) {
        const substr = envConfig.substring(first, last + 1);
        try { c = JSON.parse(substr); } catch (e) {}
        if (!c && substr.indexOf('\\"') >= 0) {
          try { c = JSON.parse(substr.replace(/\\"/g, '"')); } catch (e) {}
        }
      }
    }

    // Попытка 4: может это JSON-stringified JSON (т.е. строка в строке)
    if (!c) {
      try {
        const inner = JSON.parse(envConfig);
        if (typeof inner === 'string') {
          try { c = JSON.parse(inner); } catch (e) {}
        }
      } catch (e) {}
    }

    if (c && c.baseUrl && c.apiKey) return c;
  }
  // 2) Пробуем стандартные пути (для локального dev)
  const homeDir = os.homedir();
  const configPaths = [
    path.join(process.cwd(), ".z-ai-config"),
    path.join(homeDir, ".z-ai-config"),
    "/etc/.z-ai-config",
  ];
  for (const p of configPaths) {
    try {
      const cfgStr = fs.readFileSync(p, "utf-8");
      const c = JSON.parse(cfgStr);
      if (c.baseUrl && c.apiKey) return c;
    } catch (e) {}
  }
  return null;
}

async function getZai() {
  if (zaiInstance) return zaiInstance;
  const config = parseConfigFromEnvOrFile();
  if (!config) {
    throw new Error("Configuration not found. Set Z_AI_CONFIG env var or create .z-ai-config file.");
  }
  try { fs.writeFileSync("/tmp/.z-ai-config", JSON.stringify(config), { mode: 0o600 }); } catch (e) {}
  try {
    const homeTarget = path.join(os.homedir(), ".z-ai-config");
    fs.writeFileSync(homeTarget, JSON.stringify(config), { mode: 0o600 });
  } catch (e) {}
  zaiInstance = new ZAI(config);
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
  dayOfWeek: number;
  title: string;
  blocks: BlockShape[];
}

interface PlanShape {
  title: string;
  durationWeeks: number;
  weeks: { weekNumber: number; note: string; days: DayShape[] }[];
  basis?: string;
}

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

function fixJsonString(raw) {
  let out = raw;
  out = out.replace(
    /"(reps|note)":\s*(\d+\s*-\s*\d+\s*[а-яА-Яa-zA-Z\s]*)/g,
    (_m, key, val) => `"${key}":"${val.trim()}"`
  );
  out = out.replace(
    /"reps":\s*(\d+(?:\s*-\s*\d+)?)\s*([,}])/g,
    (_m, val, sep) => `"reps":"${val}"${sep}`
  );
  function countBalance(s) {
    let ob = 0, obk = 0, ins = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { ins = !ins; continue; }
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
    let toTrim = -bal.braces + -bal.brackets;
    let end = out.length;
    while (toTrim > 0 && end > 0) {
      const ch = out[end - 1];
      if (ch === "}" || ch === "]") { end--; toTrim--; }
      else if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") { end--; }
      else { break; }
    }
    out = out.substring(0, end);
  }
  if (bal.braces > 0 || bal.brackets > 0) {
    out = out + "]".repeat(Math.max(0, bal.brackets)) + "}".repeat(Math.max(0, bal.braces));
  }
  return out;
}

function parseActions(raw) {
  const re = /```actions\s*?\n?([\s\S]*?)```/g;
  const actions = [];
  let cleanText = raw;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const fixed = fixJsonString(match[1]);
    const parsed = tryParseActionsJson(fixed);
    if (Array.isArray(parsed?.actions)) {
      for (const a of parsed.actions) {
        if (a && typeof a === "object" && typeof a.type === "string") {
          actions.push(a);
        }
      }
    }
  }
  if (actions.length) {
    cleanText = raw.replace(re, "").trim();
  }
  return { cleanText, actions };
}

function tryParseActionsJson(s) {
  try {
    const p = JSON.parse(s);
    if (Array.isArray(p?.actions)) return p;
  } catch (e) {}
  const candidates = [];
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
    } catch (e) {}
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "]") {
      const c = s.substring(0, i) + s.substring(i + 1);
      try {
        const p = JSON.parse(c);
        if (Array.isArray(p?.actions)) return p;
      } catch (e) {}
    }
    if (s[i] === "}") {
      const c = s.substring(0, i) + s.substring(i + 1);
      try {
        const p = JSON.parse(c);
        if (Array.isArray(p?.actions)) return p;
      } catch (e) {}
    }
  }
  const bal = countBalance(s);
  if (bal.brackets > 0) {
    const added = s + "]".repeat(bal.brackets);
    try {
      const p = JSON.parse(added);
      if (Array.isArray(p?.actions)) return p;
    } catch (e) {}
  }
  if (bal.braces > 0) {
    const added = s + "}".repeat(bal.braces);
    try {
      const p = JSON.parse(added);
      if (Array.isArray(p?.actions)) return p;
    } catch (e) {}
  }
  return null;
}

function countBalance(s) {
  let ob = 0, obk = 0, ins = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { ins = !ins; continue; }
    if (ins) continue;
    if (ch === "{") ob++;
    else if (ch === "}") ob--;
    else if (ch === "[") obk++;
    else if (ch === "]") obk--;
  }
  return { braces: ob, brackets: obk };
}

function isValidPlan(p) {
  if (!p || typeof p !== "object") return false;
  if (typeof p.title !== "string") return false;
  if (typeof p.durationWeeks !== "number") return false;
  if (!Array.isArray(p.weeks)) return false;
  for (const w of p.weeks) {
    if (!w || typeof w !== "object") return false;
    if (typeof w.weekNumber !== "number") return false;
    if (typeof w.note !== "string") return false;
    if (!Array.isArray(w.days)) return false;
    for (const d of w.days) {
      if (!d || typeof d !== "object") return false;
      if (typeof d.dayOfWeek !== "number") return false;
      if (typeof d.title !== "string") return false;
      if (!Array.isArray(d.blocks)) return false;
      for (const b of d.blocks) {
        if (!b || typeof b !== "object") return false;
        if (typeof b.exerciseId !== "string") return false;
        if (typeof b.sets !== "number") return false;
        if (typeof b.reps !== "string") return false;
        if (b.weightKg !== null && typeof b.weightKg !== "number") return false;
        if (typeof b.restSec !== "number") return false;
      }
    }
  }
  return true;
}

function sanitizeActions(actions) {
  const out = [];
  for (const a of actions) {
    if (a.type === "replace_plan") {
      if (isValidPlan(a.plan)) {
        const plan = a.plan;
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

export async function GET() {
  const envKeys = Object.keys(process.env).filter(k => !k.startsWith("npm_") && !k.startsWith("VERCEL_") && !k.startsWith("NEXT_"));
  let parseResult = null;
  let parseError = null;
  if (process.env.Z_AI_CONFIG) {
    try {
      const parsed = JSON.parse(process.env.Z_AI_CONFIG);
      parseResult = {
        hasBaseUrl: !!parsed.baseUrl,
        hasApiKey: !!parsed.apiKey,
        baseUrl: parsed.baseUrl,
        apiKey: parsed.apiKey,
      };
    } catch (e) {
      parseError = e.message;
    }
  }
  return NextResponse.json({
    has_Z_AI_CONFIG: !!process.env.Z_AI_CONFIG,
    Z_AI_CONFIG_length: process.env.Z_AI_CONFIG ? process.env.Z_AI_CONFIG.length : 0,
    Z_AI_CONFIG_first_100: process.env.Z_AI_CONFIG ? process.env.Z_AI_CONFIG.substring(0, 100) : null,
    Z_AI_CONFIG_middle_50: process.env.Z_AI_CONFIG ? process.env.Z_AI_CONFIG.substring(400, 450) : null,
    Z_AI_CONFIG_last_50: process.env.Z_AI_CONFIG ? process.env.Z_AI_CONFIG.substring(process.env.Z_AI_CONFIG.length - 50) : null,
    parseResult,
    parseError,
    visible_env_keys: envKeys.slice(0, 30),
    cwd: process.cwd(),
    home: os.homedir(),
  });
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = (body.message || "").toString().trim();
    const context = (body.context || "").toString().trim();
    const history = (body.history || "").toString().trim();

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

    const messages = [
      { role: "assistant", content: SYSTEM_PROMPT },
    ];

    if (context) {
      messages.push({
        role: "assistant",
        content: "Вот текущий контекст пользователя из приложения. Учитывай его при ответе:\n\n" + context,
      });
    }

    if (history) {
      messages.push({
        role: "assistant",
        content: "Вот предыдущая история диалога (последние сообщения). Используй её, чтобы не задавать уточняющие вопросы повторно:\n\n" + history,
      });
    }

    messages.push({ role: "user", content: message });

    const completion = await zai.chat.completions.create({
      messages,
      thinking: { type: "disabled" },
      max_tokens: 16000,
    });

    let rawAnswer = completion.choices?.[0]?.message?.content?.trim() || "";

    function hasUnclosedActionsBlock(text) {
      const startIdx = text.indexOf("```actions");
      if (startIdx < 0) return false;
      const after = text.slice(startIdx + "```actions".length);
      return !after.includes("```");
    }

    let continuationTries = 0;
    while (continuationTries < 3 && hasUnclosedActionsBlock(rawAnswer)) {
      continuationTries++;
      const continueMessages = [
        ...messages,
        { role: "assistant", content: rawAnswer },
        {
          role: "user",
          content: "Продолжи свой ответ с того места, где остановился. Не повторяй уже написанное, просто допиши окончание JSON-блока действий и закрой его тремя обратными кавычками (```)",
        },
      ];
      try {
        const cont = await zai.chat.completions.create({
          messages: continueMessages,
          thinking: { type: "disabled" },
          max_tokens: 16000,
        });
        const contText = cont.choices?.[0]?.message?.content?.trim() || "";
        if (contText) {
          rawAnswer = rawAnswer + contText;
        } else {
          break;
        }
      } catch (e) {
        break;
      }
    }

    if (!rawAnswer) {
      return NextResponse.json(
        { ok: false, error: "AI вернул пустой ответ" },
        { status: 502 }
      );
    }

    const { cleanText, actions } = parseActions(rawAnswer);
    const sanitized = sanitizeActions(actions);

    return NextResponse.json({
      ok: true,
      answer: cleanText,
      actions: sanitized,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/ai] error:", msg);
    return NextResponse.json(
      { ok: false, error: "Ошибка AI: " + msg },
      { status: 500 }
    );
  }
}

export const dynamic = "force-dynamic";
