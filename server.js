import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionFrom, parseCookie } from "./lib/session.js";
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

// ---- OAuth-флоу (вариант А, сессия пользователя) --------------------------
// BASE указывает на https://vibecode.bitrix24.tech/v1. В настройках приложения
// в VibeCode должен быть зарегистрирован redirect_uri = APP_ORIGIN/oauth/callback.
const APP_BASE_URL = process.env.APP_URL || ""; // например https://app-<id>.vibecode.bitrix24.tech
const REDIRECT_URI = `${APP_BASE_URL}/oauth/callback`;
const OAUTH_SCOPE = "crm,user";
const SESSION_COOKIE = "vibe_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа
const stateStore = new Map(); // state -> { used:false, createdAt }

function newState() {
  const s = randomBytes(18).toString("base64url");
  stateStore.set(s, { used: false, createdAt: Date.now() });
  // подчистим старые (старше 10 минут)
  for (const [k, v] of stateStore) {
    if (Date.now() - v.createdAt > 10 * 60 * 1000) stateStore.delete(k);
  }
  return s;
}

function consumeState(state) {
  const rec = stateStore.get(state);
  if (!rec || rec.used) return false;
  rec.used = true;
  return true;
}

async function exchangeCode(code) {
  if (!KEY || !BASE) throw new PortalError("no_key", "app key or proxy absent");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PORTAL_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        app_key: KEY,
        code,
        redirect_uri: REDIRECT_URI,
      }),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    // Лог обмена token: статус и (санитарно) тело без чувствительных значений.
    const sanitized = data
      ? JSON.stringify({
          error: data?.error?.code ?? null,
          message: data?.error?.message ?? null,
          ok: data?.ok ?? undefined,
        })
      : text.slice(0, 300);
    console.log(`[oauth] /oauth/token -> HTTP ${res.status} :: ${sanitized}`);
    if (!res.ok) {
      console.log(
        `[oauth] token failed: code=${data?.error?.code ?? null} message=${
          data?.error?.message ?? null
        } status=${res.status}`,
      );
      throw new PortalError(
        res.status === 401 ? "denied" : "portal_error",
        data?.error?.message || `oauth_token_${res.status}`,
        res.status,
      );
    }
    const token = data?.access_token ?? data?.data?.access_token ?? null;
    return { token, raw: data };
  } finally {
    clearTimeout(timer);
  }
}

console.log(
  `auth: ${KEY ? "app key from " + (KEY_FROM_ENVIRONMENT ? "env" : ENV_FILE) : "session of the signed-in user"} · proxy: ${
    BASE ? "configured" : "MISSING"
  }`,
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

// Запрос к порталу. Аутентификация — ключ приложения (X-Api-Key) + сессия
// пользователя. Сессия шлюза из заголовка X-Vibe-Authorization передаётся в
// /v1/* стандартным заголовком Authorization (Bearer vibe_session_…), чтобы
// данные отдавались от лица вошедшего пользователя; ключ X-Api-Key идёт вместе
// с ней и открывает доступ к данным портала.
async function portal(pathname, { method = "GET", body, params, session } = {}) {
  if (!BASE) throw new PortalError("no_key", "proxy base url is absent");
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
          Accept: "application/json",
          ...(session ? { "Authorization": session } : {}),
          ...(KEY ? { "X-Api-Key": KEY } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
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
      const pe = new PortalError(
        kind,
        data?.error?.message || `portal_error_${res.status}`,
        res.status,
      );
      // C2: сохраняем код ошибки портала (например AGGREGATION_LIMIT_EXCEEDED),
      // чтобы обработчик мог отличить его от обычного сбоя.
      pe.code = data?.error?.code || null;
      throw pe;
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
  no_session: 401,
  no_key: 503,
  timeout: 504,
  unreachable: 504,
  rate_limited: 429,
  denied: 401,
  forbidden: 403,
  portal_error: 502,
};
const TEXT_BY_KIND = {
  no_session: "Требуется авторизация: сессия пользователя не передана.",
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
// Справочники ходим той же сессией/ключом, что и сделки. Отказ словаря не
// роняет refresh, а лишь помечается (M1): пользователь видит предупреждение.
async function fetchStageDictionaries(session) {
  let categories = [];
  let categoriesError = null;
  try {
    const res = await portal("/deal-categories", { params: { limit: 100 }, session });
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
        session,
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

async function fetchUserNames(ids, session) {
  const distinct = [...new Set(ids.filter((v) => v != null && v !== ""))];
  const users = [];
  for (let i = 0; i < distinct.length; i += 50) {
    const chunk = distinct.slice(i, i + 50);
    let ok = false;
    try {
      const { value } = await portal("/users/search", {
        method: "POST",
        body: { filter: { id: { $in: chunk } }, limit: 50 },
        session,
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
      select: ["id", "title", "stageId", "amount", "assignedById", "createdAt"],
    },
    session,
  });
  return value.map(normalizeDateFields);
}

async function buildSnapshotForKey(key, session) {
  const entry = getOrCreate(key);
  if (entry.building) return;
  entry.building = true;
  try {
    const stageDefs = await fetchStageDictionaries(session);
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
    await buildSnapshotForKey(key, entry.session ?? null);
    await sleep(50);
  }
}

async function dashboardFor({ key, session, period, from, to }) {
  const entry = getOrCreate(key);
  if (session) entry.session = session; // для фоновых обновлений словарей
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
  const warnings = [];
  let agg;
  try {
    agg = await aggregatePeriod({
      session,
      from: iso.from,
      to: iso.to,
      stageIndex,
    });
  } catch (err) {
    // C2: 422 AGGREGATION_LIMIT_EXCEEDED приходит исключением (portal()
    // бросает PortalError до формирования raw), ловим по коду/статусу.
    if (err.code === "AGGREGATION_LIMIT_EXCEEDED" || err.status === 422) {
      return {
        ok: true,
        period: { key: range.key, ...iso },
        kpi: { openSum: 0, wonCount: 0, wonSum: 0, avgCheck: 0 },
        funnel: [],
        recent: [],
        totals: { found: 0, groups: 0 },
        warnings: [
          "Агрегация превысила лимит портала (AGGREGATION_LIMIT_EXCEEDED) — сузьте период.",
        ],
      };
    }
    throw err;
  }
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
    .map((d) => d.assignedById ?? d.responsibleId)
    .filter((v) => v != null);
  const respUsers = await fetchUserNames(respIds, session);
  const usersIndex = buildUsersIndex(respUsers);
  const recent = recentRes.map((d) => {
    const stageId = d.stageId ?? "";
    const meta = stageIndex.byCode.get(stageId);
    const respId = d.assignedById ?? d.responsibleId;
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
  if (entry.data?.stageError) {
    warnings.push("Не удалось загрузить словарь стадий — показываю коды вместо названий; выигранные определяются на доверии коду WON.");
  }
  // M2/AGGR: вторая ветка потолка агрегации — truncation по строкам/группам.
  if (metaAgg.truncated === true || metaAgg.groupsTruncated === true) {
    warnings.push("Слишком широкий период: агрегация портала обрезана (потолок 5000) — цифры могут быть неполными.");
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

  // --- OAuth: start -------------------------------------------------------
  if (url.pathname === "/oauth/start") {
    if (!APP_BASE_URL || !KEY) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OAuth не настроен: задайте APP_URL и ключ приложения.");
      return;
    }
    const state = newState();
    const authorizeUrl =
      `${BASE}/oauth/authorize` +
      `?app_key=${encodeURIComponent(KEY)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent(OAUTH_SCOPE)}`;
    // Пункт 1: проверка формирования URL (app_key маскируем, суть — параметры).
    const maskKey = KEY.length > 8 ? `${KEY.slice(0, 8)}…${KEY.slice(-4)}` : "[short]";
    console.log(
      `[oauth] /oauth/start -> authorize\n` +
        `  app_key        : ${maskKey}\n` +
        `  redirect_uri   : ${REDIRECT_URI}\n` +
        `  scope          : ${OAUTH_SCOPE}\n` +
        `  state          : ${state}\n` +
        `  url            : ${BASE}/oauth/authorize?app_key=${maskKey}&redirect_uri=${encodeURIComponent(
          REDIRECT_URI,
        )}&state=${state}&scope=${encodeURIComponent(OAUTH_SCOPE)}`,
    );
    res.writeHead(302, { Location: authorizeUrl });
    res.end();
    return;
  }

  // --- OAuth: callback ----------------------------------------------------
  if (url.pathname === "/oauth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error") || null;
    const errorDesc = url.searchParams.get("error_description") || null;
    // Пункт 2: логируем query-параметры (code — частично, т.к. чувствителен).
    const codeMask = code ? (code.length > 8 ? `${code.slice(0, 8)}…` : "[short]") : null;
    console.log(
      `[oauth] /oauth/callback -> code=${codeMask} state=${state} error=${
        error ?? null
      } error_description=${errorDesc ?? null}`,
    );
    if (error) {
      console.log(`[oauth] authorize error: ${error} :: ${errorDesc ?? "—"}`);
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Авторизация отклонена: ${error} ${errorDesc ?? ""}`.trim());
      return;
    }
    if (!code || !state || !consumeState(state)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Невалидные параметры OAuth-ответа (code/state).");
      return;
    }
    try {
      const exchanged = await exchangeCode(code);
      if (!exchanged.token) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("OAuth-обмен не вернул access_token.");
        return;
      }
      // Ставим httpOnly-куку с сессией и уходим на главную клиентским
      // переходом (Set-Cookie на 302 шлюз не пробрасывает).
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(
        exchanged.token,
      )}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": cookie,
      });
      res.end(
        "<!doctype html><meta charset=utf-8><title>Вход выполнен</title>" +
          "<p>Вход выполнен. Перенаправляем…</p>" +
          "<script>window.location.replace('/');</script>",
      );
      return;
    } catch (err) {
      res.writeHead(err.status || 502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Не удалось завершить вход: ${err.message}`);
      return;
    }
  }

  // --- OAuth: выход (опционально) ------------------------------------------
  if (url.pathname === "/oauth/logout") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
    });
    res.end(
      "<!doctype html><meta charset=utf-8><p>Вы вышли. <a href='/oauth/start'>Войти</a></p>",
    );
    return;
  }

  // --- /api/dashboard ------------------------------------------------------
  if (url.pathname === "/api/dashboard") {
    const entry = getOrCreate(key);
    const period = url.searchParams.get("period") || "month";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    // С1: без сессии (и без локального ключа для разработки) — 401 сразу,
    // без обращения к порталу. Анонимный запрос данных не обслуживается.
    if (!session && !KEY) {
      writeJson(res, HTTP_BY_KIND.no_session, { error: TEXT_BY_KIND.no_session, kind: "no_session" });
      return;
    }

    const meta = {
      updatedAt: entry.at ? new Date(entry.at).toISOString() : null,
      ageMs: entry.at ? Date.now() - entry.at : null,
      building: entry.building,
    };

    if (!entry.data) {
      // Первое обращение пользователя — соберём словари.
      if (!entry.building) {
        if (session) entry.session = session;
        void buildSnapshotForKey(key, session);
      }
      const canAuth = Boolean(session) || Boolean(KEY);
      const kind = entry.error?.kind ?? (BASE && canAuth ? "loading" : "no_key");
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
  // M7: только факт наличия доступа, без путей и текстов ошибок.
  if (url.pathname === "/api/health") {
    writeJson(res, 200, {
      status: "ok",
      keyPresent: Boolean(KEY),
      sessionPresent: Boolean(session),
      authAvailable: Boolean(session) || Boolean(KEY),
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

  // --- статика только из public/ -----------------------------------------
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const isDotfile = rel.split("/").some((seg) => seg.startsWith("."));
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const insidePublic = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (isDotfile || !insidePublic) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  // Страницы (HTML, в т.ч. "/") требуют сессии: без неё — редирект на OAuth.
  const isHtml = path.extname(filePath) === ".html" || url.pathname === "/";
  const localDev = Boolean(KEY) && !APP_BASE_URL; // локальный запуск без OAuth
  if (isHtml && !session && !localDev) {
    res.writeHead(302, { Location: "/oauth/start" });
    res.end();
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
