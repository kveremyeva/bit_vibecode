import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStageIndex, buildUsersIndex, isoRange, resolvePeriod } from "./lib/calc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Загрузка .env для локального запуска, поиск вверх от файла сервера.
// На деплое переменные приходят из окружения, .env там нет.
function loadEnvUpwards(startDir, maxLevels = 4) {
  let dir = path.resolve(startDir);
  for (let level = 0; level <= maxLevels; level += 1) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) {
      try {
        for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
          if (!m || m[1] in process.env) continue;
          process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
        }
      } catch {
        // Нечитаемый файл — считаем отсутствующим.
      }
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const KEY_FROM_ENVIRONMENT =
  typeof process.env.BITRIX_API_KEY === "string" &&
  process.env.BITRIX_API_KEY !== "";
const ENV_FILE = loadEnvUpwards(__dirname);

const PORT = process.env.PORT || 3000;
const BASE = process.env.BITRIX_API_BASE_URL || "";
const KEY = process.env.BITRIX_API_KEY || "";
const DOMAIN = process.env.BITRIX_PORTAL_DOMAIN || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const PORTAL_TIMEOUT_MS = Number(process.env.PORTAL_TIMEOUT_MS || 180_000);
const CACHE_MS = Number(process.env.CACHE_MS || 5 * 60_000);
const AGG_LIMIT = 5000;

console.log(
  KEY
    ? `portal key loaded from ${
        KEY_FROM_ENVIRONMENT ? "the environment" : ENV_FILE
      }`
    : `NO portal key: ${
        ENV_FILE
          ? `${ENV_FILE} has no BITRIX_API_KEY`
          : "no .env found and none in the environment"
      } — /api/* will report the missing key until it appears`,
);

class PortalError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status ?? null;
    this.retryAfter = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Диагностический вариант portal(): возвращает сырой текст и статус,
// не бросая исключений. Используется только дебаг-маршрутом.
async function portalRaw(pathname, { method = "GET", body, session } = {}) {
  if (!KEY || !BASE)
    return { status: 503, text: '{"error":"no_key"}' };
  const url = new URL(`${BASE}${pathname}`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PORTAL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": KEY,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(session ? { "X-Vibe-Authorization": session } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: String(err.message) };
  } finally {
    clearTimeout(timer);
  }
}

// Запрос к порталу. Дополнительный заголовок X-Vibe-Authorization (сессия
// шлюза) пробрасывается вместе с ключом приложения: тогда портал отдаёт
// данные именно того пользователя, который открыл приложение.
async function portal(pathname, { method = "GET", body, params, session } = {}) {
  if (!KEY || !BASE) throw new PortalError("no_key", "portal env vars are absent");
  const build = async () => {
    const url = new URL(`${BASE}${pathname}`);
    if (params) {
      for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, String(v));
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PORTAL_TIMEOUT_MS);
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": KEY,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(session ? { "X-Vibe-Authorization": session } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
    } catch (err) {
      const kind = err?.name === "AbortError" ? "timeout" : "unreachable";
      throw new PortalError(kind, `${pathname} ${kind} after ${Date.now() - startedAt}ms`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      // M6: 401 (сессия/ключ) и 403 (не хватает прав) — разные ситуации.
      // M3: 429 — единственный статус, который стоит повторить после паузы.
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || null;
        const pe = new PortalError("rate_limited", "rate limited", 429);
        pe.retryAfter = retryAfter;
        throw pe;
      }
      const kind =
        res.status === 401
          ? "denied"
          : res.status === 403
            ? "forbidden"
            : "portal_error";
      throw new PortalError(
        kind,
        data?.error?.message || `portal_error_${res.status}`,
        res.status,
      );
    }

    console.log(`[portal] ${pathname} -> ${res.status} in ${Date.now() - startedAt}ms`);
    const payload = data?.data ?? data;
    return {
      value: Array.isArray(payload) ? payload : (payload?.items ?? payload ?? []),
      meta: data?.meta ?? null,
      raw: data,
    };
  };

  // M3: один повтор при 429 с паузой по Retry-After (по умолчанию 1 с).
  try {
    return await build();
  } catch (err) {
    if (err?.kind !== "rate_limited") throw err;
    const wait = err.retryAfter != null ? Math.min(err.retryAfter * 1000, 15_000) : 1000;
    console.log(`[portal] 429, retrying ${pathname} after ${wait}ms`);
    await sleep(wait);
    return await build();
  }
}

const HTTP_BY_KIND = {
  no_key: 503,
  timeout: 504,
  unreachable: 504,
  rate_limited: 429,
  denied: 401,
  forbidden: 403,
  portal_error: 502,
};
const TEXT_BY_KIND = {
  no_key: "Портал не подключён — приложение запущено без ключа доступа.",
  timeout:
    "Портал отвечает дольше обычного, данные ещё не готовы. Он под нагрузкой — попробуйте через несколько минут.",
  unreachable: "Не удалось связаться с порталом. Похоже на временный сбой сети.",
  rate_limited: "Слишком много запросов к порталу. Данные обновятся через несколько минут.",
  denied: "Сессия или ключ доступа отклонены порталом. Переподключите Битрикс24.",
  forbidden:
    "Недостаточно прав на чтение сделок CRM. Убедитесь, что у приложения запрошены скопы CRM.",
  portal_error: "Портал вернул ошибку при запросе данных.",
};

// ---- кэш данных на пользователя -------------------------------------------
// Каждый вошедший пользователь (X-Vibe-User-Id) получает собственный снимок
// и собственную портальную сессию. Локально (без заголовков шлюза) ключ кэша
// — "local", а портал вызывается только ключом приложения.
const userCache = new Map(); // key -> { data, at, error, building }

function cacheKey(req) {
  const id = req.headers["x-vibe-user-id"];
  return id && /^\d+$/.test(String(id)) ? `user:${id}` : "local";
}

function sessionFrom(req) {
  return req.headers["x-vibe-authorization"] || null;
}

function getOrCreate(key) {
  let entry = userCache.get(key);
  if (!entry) {
    entry = { data: null, at: 0, error: null, building: false };
    userCache.set(key, entry);
  }
  return entry;
}

function normalizeDateFields(deal) {
  const out = { ...deal };
  for (const key of ["createdAt", "updatedAt", "closeDate"]) {
    if (out[key] != null && typeof out[key] !== "string") {
      out[key] = new Date(out[key]).toISOString();
    }
  }
  return out;
}

// ---- словари (стадии, воронки, пользователи) -------------------------------
// Справочники не зависят от конкретного пользователя, поэтому их тянем по
// ключу приложения (без сессии) и устойчиво: отказ словаря не роняет refresh,
// а лишь помечается (M1). Сессия пробрасывается только к запросам сделок.
async function fetchStageDictionaries() {
  let categories = [];
  let categoriesError = null;
  try {
    const res = await portal("/deal-categories", { params: { limit: 100 } });
    categories = res.value || [];
  } catch (err) {
    categoriesError = err.kind || "portal_error";
    console.log(`[fetch] deal-categories failed: ${err.kind} — ${err.message}`);
  }
  const ids = new Set([0]);
  for (const cat of categories || []) {
    if (cat?.id != null) ids.add(cat.id);
  }
  const dicts = [];
  for (const id of ids) {
    dicts.push(id === 0 ? { categoryId: 0, entityId: "DEAL_STAGE" } : { categoryId: id, entityId: `DEAL_STAGE_${id}` });
  }
  const stages = [];
  let stageError = null;
  for (const dict of dicts) {
    try {
      const { value } = await portal("/statuses/search", {
        method: "POST",
        body: { filter: { entityId: dict.entityId }, sort: { sort: "asc" }, limit: 200 },
      });
      stages.push(...value.map((s) => ({ ...s, categoryId: dict.categoryId })));
    } catch (err) {
      // M1: не проглатываем отказ словаря — запоминаем и покажем пользователю.
      stageError = stageError || categoriesError || err.kind || "portal_error";
      console.log(`[fetch] stages ${dict.entityId} failed: ${err.kind} — ${err.message}`);
    }
  }
  return { categories, stages, stageError: stageError || categoriesError };
}

async function fetchUserNames(ids) {
  const distinct = [...new Set(ids.filter((v) => v != null && v !== ""))];
  const users = [];
  for (let i = 0; i < distinct.length; i += 50) {
    const chunk = distinct.slice(i, i + 50);
    let ok = false;
    try {
      const { value } = await portal("/users/search", {
        method: "POST",
        body: { filter: { id: { $in: chunk } }, limit: 50 },
      });
      users.push(...value);
      ok = true;
    } catch (err) {
      console.log("[fetch] users.search failed: " + err.kind);
    }
    if (!ok) break;
  }
  return users;
}

// ---- агрегация --------------------------------------------------------------
// KPI и воронка считаются сервером портала через /deals/aggregate с фильтром
// по дате создания за период. Последние сделки — отдельным search с limit.
function normalizeGroup(funnelGroup, stageIndex) {
  const stageId = funnelGroup?.stageId ?? funnelGroup?.id ?? "";
  const meta = stageIndex.byCode.get(stageId);
  return {
    stageId,
    name: meta?.name || stageId || "Без стадии",
    count: Number(funnelGroup?.count ?? 0),
    sum: Number(
      funnelGroup?.aggregates?.amount?.sum ??
        funnelGroup?.sum ??
        funnelGroup?.amount ??
        0,
    ),
    color: meta?.color || null,
    entityId: meta?.entityId || "DEAL_STAGE",
  };
}

function distinctWon(groups, stageIndex) {
  return groups
    .filter((g) => stageIndex.wonIds.has(g.stageId))
    .map((g) => g.stageId);
}

async function aggregatePeriod({ session, from, to, stageIndex }) {
  const filter = { createdAt: { $gte: from, $lte: to } };
  const body = {
    filter,
    aggregate: [{ field: "amount", function: "sum" }],
    groupBy: "stageId",
  };
  return portal("/deals/aggregate", { method: "POST", body, session });
}

async function recentDeals({ session, from, to }) {
  const { value } = await portal("/deals/search", {
    method: "POST",
    body: {
      filter: { createdAt: { $gte: from, $lte: to } },
      sort: { createdAt: "desc" },
      limit: 20,
      select: ["id", "title", "stageId", "amount", "responsibleId", "createdAt"],
    },
    session,
  });
  return value.map(normalizeDateFields);
}

async function buildSnapshotForKey(key) {
  const entry = getOrCreate(key);
  if (entry.building) return;
  entry.building = true;
  try {
    const stageDefs = await fetchStageDictionaries();
    entry.data = {
      stages: stageDefs.stages,
      categories: stageDefs.categories,
      stageError: stageDefs.stageError,
      domain: DOMAIN,
      fetchedAt: new Date().toISOString(),
    };
    entry.at = Date.now();
    entry.error = null;
  } catch (err) {
    entry.error = { kind: err.kind || "portal_error", message: err.message };
    console.log(`[refresh] ${key} failed: ${entry.error.kind} — ${err.message}`);
  } finally {
    entry.building = false;
  }
}

async function refresh() {
  const keys = userCache.size ? [...userCache.keys()] : ["local"];
  for (const key of keys) {
    const entry = userCache.get(key) || getOrCreate(key);
    if (entry.building) continue;
    await buildSnapshotForKey(key);
    await sleep(50);
  }
}

async function dashboardFor({ key, session, period, from, to }) {
  const entry = getOrCreate(key);
  const stageIndex = buildStageIndex(entry.data?.stages);
  const range = resolvePeriod(period, from, to);
  if (!range) {
    return {
      ok: false,
      error: "Некорректный период: укажите «произвольный период» с датой «от» не позже «до».",
      periods: ["today", "yesterday", "week", "month", "custom"],
    };
  }
  const iso = isoRange(range);
  const agg = await aggregatePeriod({
    session,
    from: iso.from,
    to: iso.to,
    stageIndex,
  });
  const aggData = agg.raw?.data ?? agg.raw ?? {};
  const rawGroups = Array.isArray(aggData?.groups) ? aggData.groups : [];
  const groups = rawGroups.map((g) => normalizeGroup(g, stageIndex)).filter((g) => g.stageId);
  const wonIds = distinctWon(groups, stageIndex);
  const wonGroups = groups.filter((g) => wonIds.includes(g.stageId));
  const openGroups = groups.filter((g) => !wonIds.includes(g.stageId));
  const wonCount = wonGroups.reduce((s, g) => s + g.count, 0);
  const wonSum = wonGroups.reduce((s, g) => s + g.sum, 0);
  const openSum = openGroups.reduce((s, g) => s + g.sum, 0);

  const recentRes = await recentDeals({ session, from: iso.from, to: iso.to });
  const respIds = recentRes
    .map((d) => d.responsibleId ?? d.assignedById)
    .filter((v) => v != null);
  const respUsers = await fetchUserNames(respIds);
  const usersIndex = buildUsersIndex(respUsers);
  const recent = recentRes.map((d) => {
    const stageId = d.stageId ?? "";
    const meta = stageIndex.byCode.get(stageId);
    const respId = d.responsibleId ?? d.assignedById;
    const user = usersIndex.get(String(respId));
    return {
      id: d.id,
      title: d.title ?? "Без названия",
      amount: Number(d.amount ?? 0) || 0,
      stageId,
      stageName: meta?.name || stageId || "Без стадии",
      responsibleName: user ? [user.lastName, user.name].filter(Boolean).join(" ") || user.email || "—" : "—",
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
    };
  });

  const metaAgg = aggData?.meta ?? agg.meta ?? {};
  const warnings = [];
  if (entry.data?.stageError) {
    warnings.push("Не удалось загрузить словарь стадий — показываю коды вместо названий; выигранные определяются на доверии коду WON.");
  }
  // M2/AGGR: обе ветки потолка агрегации.
  if (metaAgg.truncated === true || metaAgg.groupsTruncated === true) {
    warnings.push("Слишком широкий период: агрегация портала обрезана (потолок 5000) — цифры могут быть неполными.");
  }
  if (
    agg.raw?.error?.code === "AGGREGATION_LIMIT_EXCEEDED" ||
    metaAgg?.aggregationLimitExceeded
  ) {
    warnings.push("Агрегация превысила лимит портала (AGGREGATION_LIMIT_EXCEEDED) — сузьте период.");
  }

  return {
    ok: true,
    period: { key: range.key, ...iso },
    kpi: {
      openSum,
      wonCount,
      wonSum,
      avgCheck: wonCount > 0 ? wonSum / wonCount : 0,
    },
    funnel: openGroups.concat(wonGroups),
    recent,
    totals: {
      found: groups.reduce((s, g) => s + g.count, 0),
      groups: groups.length,
    },
    warnings,
  };
}

function writeJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  const key = cacheKey(req);
  const session = sessionFrom(req);

  // --- /api/dashboard ------------------------------------------------------
  if (url.pathname === "/api/dashboard") {
    const entry = getOrCreate(key);
    const period = url.searchParams.get("period") || "month";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const meta = {
      updatedAt: entry.at ? new Date(entry.at).toISOString() : null,
      ageMs: entry.at ? Date.now() - entry.at : null,
      building: entry.building,
    };

    if (!entry.data) {
      // Первое обращение пользователя — соберём словари.
      if (!entry.building) {
        void buildSnapshotForKey(key);
      }
      const kind = entry.error?.kind ?? (KEY && BASE ? "loading" : "no_key");
      if (kind === "loading") {
        writeJson(res, 202, {
          error: "Данные ещё загружаются. Портал отвечает медленно, подождите.",
          meta,
        });
        return;
      }
      writeJson(res, HTTP_BY_KIND[kind] || 500, { error: TEXT_BY_KIND[kind], kind, meta });
      return;
    }

    // Данные есть: считаем дашборд на лету (агрегатами), словари из кэша.
    try {
      const result = await dashboardFor({ key, session, period, from, to });
      const warning = entry.error
        ? TEXT_BY_KIND[entry.error.kind]
        : result.warnings?.join(" ") || null;
      writeJson(res, 200, { ...result, meta: { ...meta, warning } });
    } catch (err) {
      const kind = err.kind || "portal_error";
      writeJson(res, HTTP_BY_KIND[kind] || 502, {
        error: TEXT_BY_KIND[kind] || "Портал вернул ошибку при запросе данных.",
        kind,
        meta,
      });
    }
    return;
  }

  // --- /api/health ---------------------------------------------------------
  // M7: только факт наличия ключа, без путей и текстов ошибок.
  if (url.pathname === "/api/health") {
    writeJson(res, 200, {
      status: "ok",
      keyPresent: Boolean(KEY),
      baseUrlPresent: Boolean(BASE),
      portalTimeoutMs: PORTAL_TIMEOUT_MS,
      snapshot: {
        updatedAt:
          userCache.get(key)?.at
            ? new Date(userCache.get(key).at).toISOString()
            : null,
        deals: null, // агрегаты не хранят число строк сделок в кэше
      },
    });
    return;
  }

  // --- /api/meta: служебные данные для фронта (домен для ссылок) ----------
  if (url.pathname === "/api/meta") {
    const entry = getOrCreate(key);
    writeJson(res, 200, { domain: DOMAIN });
    return;
  }

  // --- /api/debug/aggregate: временная диагностика (только для отладки) ---
  if (url.pathname === "/api/debug/aggregate") {
    try {
      const from = url.searchParams.get("from") || "2026-08-01T00:00:00.000Z";
      const to = url.searchParams.get("to") || "2026-09-30T23:59:59.999Z";
      const raw = await portalRaw("/deals/aggregate", {
        method: "POST",
        body: {
          filter: { createdAt: { $gte: from, $lte: to } },
          aggregate: [{ field: "amount", function: "sum" }],
          groupBy: "stageId",
        },
        session,
      });
      writeJson(res, 200, { ok: true, response: raw.text, status: raw.status });
    } catch (err) {
      writeJson(res, 200, {
        ok: false,
        kind: err.kind || "unknown",
        message: err.message,
        status: err.status ?? null,
      });
    }
    return;
  }

  // --- статика только из public/ -----------------------------------------
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const isDotfile = rel.split("/").some((seg) => seg.startsWith("."));
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const insidePublic = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (isDotfile || !insidePublic) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath);
    const type =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : ext === ".svg"
              ? "image/svg+xml"
              : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(PORT, () => console.log(`listening on ${PORT}`));
void refresh();
setInterval(() => void refresh(), CACHE_MS).unref();
