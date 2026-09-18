// Чистые расчёты дашборда. Никаких сетевых вызовов здесь нет —
// функции работают над снимком данных, собранным server.js.

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

// Поля даты создания сделки: не гадаем, пробуем известные имена.
function dealDateMs(deal) {
  const raw =
    deal?.createdAt ?? deal?.dateCreate ?? deal?.created ?? deal?.DATE_CREATE;
  return toMs(raw);
}

// Составляет индекс стадий по коду: имя, порядок, цвет, семантика.
// Параллельно строит множество «выигранных» стадий (semantics "S").
export function buildStageIndex(stages) {
  const byCode = new Map();
  const wonIds = new Set();
  for (const s of stages || []) {
    const code = s?.statusId;
    if (!code) continue;
    const entry = {
      statusId: code,
      name: s.name || code,
      sort: typeof s.sort === "number" ? s.sort : 0,
      semantics: s.semantics ?? "",
      color: s.color || null,
      entityId: s.entityId || "DEAL_STAGE",
      categoryId: typeof s.categoryId === "number" ? s.categoryId : 0,
    };
    byCode.set(code, entry);
    if (entry.semantics === "S") wonIds.add(code);
  }
  return { byCode, wonIds, hasDictionary: byCode.size > 0 };
}

// Открытая сделка — не выигранная. Если словарь стадий собран, используем
// точно известные WON-стадии; иначе придерживаемся классического кода "WON".
export function isWon(deal, stageIndex) {
  const stageId = deal?.stageId ?? deal?.STAGE_ID;
  if (stageIndex.hasDictionary) return stageIndex.wonIds.has(stageId);
  return stageId === "WON";
}

// Оставляет сделки, созданные в периоде [from, to] (Date или ISO-строка).
export function filterByPeriod(deals, from, to) {
  const start = toMs(from);
  const end = toMs(to);
  if (start == null || end == null) return [];
  return (deals || []).filter((deal) => {
    const t = dealDateMs(deal);
    return t != null && t >= start && t <= end;
  });
}

// KPI: общая сумма открытых сделок, число и сумма выигранных, средний чек.
export function computeKpi(deals, stageIndex) {
  let openSum = 0;
  let wonCount = 0;
  let wonSum = 0;
  for (const deal of deals || []) {
    const amount = Number(deal?.amount ?? deal?.OPPORTUNITY ?? 0);
    const safe = Number.isFinite(amount) && amount > 0 ? amount : 0;
    if (isWon(deal, stageIndex)) {
      wonCount += 1;
      wonSum += safe;
    } else {
      openSum += safe;
    }
  }
  return {
    openSum,
    wonCount,
    wonSum,
    avgCheck: wonCount > 0 ? wonSum / wonCount : 0,
  };
}

// Воронка по стадиям: стадии, где за период есть сделки, с количеством
// и суммой. Сортировка — по порядку стадий в словаре (sort), затем по имени.
export function computeFunnel(deals, stageIndex) {
  const groups = new Map();
  for (const deal of deals || []) {
    const stageId = deal?.stageId ?? deal?.STAGE_ID ?? "";
    let g = groups.get(stageId);
    if (!g) {
      g = { stageId, count: 0, sum: 0 };
      groups.set(stageId, g);
    }
    g.count += 1;
    const amount = Number(deal?.amount ?? deal?.OPPORTUNITY ?? 0);
    if (Number.isFinite(amount) && amount > 0) g.sum += amount;
  }
  const stages = stageIndex.byCode;
  return Array.from(groups.values())
    .map((g) => {
      const meta = stages.get(g.stageId);
      return {
        stageId: g.stageId,
        name: meta?.name || g.stageId || "Без стадии",
        count: g.count,
        sum: g.sum,
        color: meta?.color || null,
        entityId: meta?.entityId || "DEAL_STAGE",
      };
    })
    .sort((a, b) => {
      const sa = stages.get(a.stageId)?.sort ?? Number.MAX_SAFE_INTEGER;
      const sb = stages.get(b.stageId)?.sort ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name, "ru");
    });
}

// Список последних сделок за период: новые сверху, максимум limit штук.
export function computeRecent(deals, stageIndex, usersIndex, limit = 20) {
  return (deals || [])
    .map((deal) => {
      const stageId = deal?.stageId ?? deal?.STAGE_ID ?? "";
      const meta = stageIndex.byCode.get(stageId);
      const responsibleId =
        deal?.responsibleId ?? deal?.assignedById ?? deal?.RESPONSIBLE_ID;
      const user = usersIndex.get(String(responsibleId));
      const t = dealDateMs(deal);
      return {
        id: deal?.id ?? deal?.ID,
        title: deal?.title ?? deal?.TITLE ?? "Без названия",
        amount: Number(deal?.amount ?? deal?.OPPORTUNITY ?? 0) || 0,
        stageId,
        stageName: meta?.name || stageId || "Без стадии",
        responsibleName: user
          ? [user.lastName, user.name].filter(Boolean).join(" ") ||
            user.email ||
            "—"
          : "—",
        createdAt: t != null ? new Date(t).toISOString() : null,
      };
    })
    .sort((a, b) => {
      if (a.createdAt === b.createdAt)
        return String(a.id).localeCompare(String(b.id));
      if (a.createdAt == null) return 1;
      if (b.createdAt == null) return -1;
      return b.createdAt.localeCompare(a.createdAt);
    })
    .slice(0, limit);
}

// Сопоставляет ответственных и их имена из списка пользователей.
export function buildUsersIndex(users) {
  const map = new Map();
  for (const u of users || []) {
    if (u?.id == null) continue;
    map.set(String(u.id), u);
  }
  return map;
}

function startOfDayMs(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// Границы периода по его ключу. now — момент расчёта (Date).
// Преобразования делаются в UTC — сервер и данные портала в UTC.
export function resolvePeriod(period, from, to, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const key = String(period || "month").toLowerCase();

  if (key === "custom") {
    const start = toMs(from);
    const end = toMs(to);
    if (start == null || end == null || start > end) return null;
    return { key, from: new Date(start), to: new Date(end) };
  }

  const dayStart = startOfDayMs(d);
  let fromMs;
  let toExclusive;
  if (key === "today") {
    fromMs = dayStart;
    toExclusive = dayStart + 86_400_000; // конец сегодняшнего дня
  } else if (key === "yesterday") {
    fromMs = dayStart - 86_400_000;
    toExclusive = dayStart; // конец вчерашнего дня = начало сегодня
  } else if (key === "week") {
    const dow = d.getUTCDay(); // 0 = воскресенье
    const offset = (dow + 6) % 7; // понедельник = 0
    fromMs = dayStart - offset * 86_400_000;
    toExclusive = dayStart + 86_400_000; // текущая неделя ещё идёт
  } else if (key === "month") {
    fromMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    toExclusive = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  } else {
    return null;
  }
  return { key, from: new Date(fromMs), to: new Date(toExclusive - 1) };
}

export function isoRange(range) {
  if (!range) return null;
  return {
    from: new Date(range.from.getTime()).toISOString(),
    to: new Date(range.to.getTime()).toISOString(),
  };
}
