import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStageIndex,
  buildUsersIndex,
  computeFunnel,
  computeKpi,
  computeRecent,
  filterByPeriod,
  isoRange,
  resolvePeriod,
} from "./lib/calc.js";

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
const REFRESH_MS = Number(process.env.REFRESH_MS || 5 * 60_000);

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
  }
}

async function portal(pathname, { method = "GET", body, params } = {}) {
  if (!KEY || !BASE) throw new PortalError("no_key", "portal env vars are absent");
  const url = new URL(`${BASE}${pathname}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
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
    const kind =
      res.status === 429
        ? "rate_limited"
        : res.status === 401 || res.status === 403
          ? "denied"
          : "portal_error";
    throw new PortalError(
      kind,
      data?.error?.message || `portal_error_${res.status}`,
      res.status,
    );
  }
  console.log(`[portal] ${pathname} -> ${res.status} in ${Date.now() - startedAt}ms`);
  // Один стабильный распаковщик: data может быть массивом, объектом с items/data.
  const payload = data?.data ?? data;
  return {
    value: Array.isArray(payload) ? payload : (payload?.items ?? payload ?? []),
    meta: data?.meta ?? null,
  };
}

const HTTP_BY_KIND = {
  no_key: 503,
  timeout: 504,
  unreachable: 504,
  rate_limited: 429,
  denied: 403,
  portal_error: 502,
};
const TEXT_BY_KIND = {
  no_key: "Портал не подключён — приложение запущено без ключа доступа.",
  timeout:
    "Портал отвечает дольше обычного, данные ещё не готовы. Он под нагрузкой — попробуйте через несколько минут.",
  unreachable: "Не удалось связаться с порталом. Похоже на временный сбой сети.",
  rate_limited: "Слишком много запросов к порталу. Данные обновятся через несколько минут.",
  denied: "Ключ доступа отклонён порталом. Переподключите Битрикс24 в приложении.",
  portal_error: "Портал вернул ошибку при запросе данных.",
};

// ---- фоновый снапшот ------------------------------------------------------
// Посетитель всегда обслуживается из памяти. Портал опрашивается по таймеру,
// а не внутри запроса. Старые данные переживают ошибку обновления.
const SNAPSHOT_PERIODS = ["today", "yesterday", "week", "month"];
const snapshot = { data: null, at: 0, error: null, building: false };

function normalizeDateFields(deal) {
  const out = { ...deal };
  for (const key of ["createdAt", "updatedAt", "closeDate"]) {
    if (out[key] != null && typeof out[key] !== "string") {
      out[key] = new Date(out[key]).toISOString();
    }
  }
  return out;
}

// Забираем все страницы сделок (до 5 000 за запрос; прокси сам дочитывает 50-страницы).
async function fetchAllDeals() {
  const all = [];
  const limit = 5000;
  let offset = 0;
  for (let i = 0; i < 20; i += 1) {
    const { value, meta } = await portal("/deals/search", {
      method: "POST",
      body: {
        filter: {},
        sort: { id: "asc" },
        limit,
        offset,
      },
    });
    all.push(...value.map(normalizeDateFields));
    const hasMore = meta?.hasMore ?? false;
    offset += limit;
    if (!hasMore || value.length === 0) break;
  }
  return all;
}

async function fetchStageDictionaries() {
  const { value: categories } = await portal("/deal-categories", {
    params: { limit: 100 },
  });
  const dicts = [];
  const defaultDict = { categoryId: 0, entityId: "DEAL_STAGE" };
  const ids = new Set([0]);
  for (const cat of categories || []) {
    if (cat?.id != null) {
      ids.add(cat.id);
    }
  }
  for (const id of ids) {
    const entityId = id === 0 ? "DEAL_STAGE" : `DEAL_STAGE_${id}`;
    dicts.push({ categoryId: id, entityId });
  }
  return { categories: categories || [], dictionaries: dicts };
}

async function fetchUserNames(ids) {
  const distinct = [...new Set(ids.filter((v) => v != null && v !== ""))];
  const users = [];
  for (let i = 0; i < distinct.length; i += 50) {
    const chunk = distinct.slice(i, i + 50);
    const { value } = await portal("/users/search", {
      method: "POST",
      body: { filter: { id: { $in: chunk } }, limit: 50 },
    });
    users.push(...value);
  }
  return users;
}

async function refresh() {
  if (snapshot.building) return;
  snapshot.building = true;
  try {
    const deals = await fetchAllDeals();
    const stageDefs = await fetchStageDictionaries();
    const stages = [];
    for (const dict of stageDefs.dictionaries) {
      try {
        const { value } = await portal("/statuses/search", {
          method: "POST",
          body: { filter: { entityId: dict.entityId }, sort: { sort: "asc" }, limit: 200 },
        });
        stages.push(...value.map((s) => ({ ...s, categoryId: dict.categoryId })));
      } catch (err) {
        console.log(`[snapshot] stages ${dict.entityId} failed: ${err.kind} — ${err.message}`);
      }
    }
    const responsibleIds = deals
      .map((d) => d.responsibleId ?? d.assignedById)
      .filter((v) => v != null);
    const users = await fetchUserNames(responsibleIds);

    snapshot.data = {
      deals,
      stages,
      users,
      categories: stageDefs.categories,
      domain: DOMAIN,
      fetchedAt: new Date().toISOString(),
    };
    snapshot.at = Date.now();
    snapshot.error = null;
  } catch (err) {
    snapshot.error = { kind: err.kind || "portal_error", message: err.message };
    console.log(`[snapshot] refresh failed: ${snapshot.error.kind} — ${err.message}`);
  } finally {
    snapshot.building = false;
  }
}

function buildDashboard(period, from, to) {
  const stageIndex = buildStageIndex(snapshot.data.stages);
  const usersIndex = buildUsersIndex(snapshot.data.users);
  const range = resolvePeriod(period, from, to);
  if (!range) {
    return {
      ok: false,
      error:
        "Некорректный период: укажите «произвольный период» с датой «от» не позже «до».",
      periods: SNAPSHOT_PERIODS,
    };
  }
  const periodDeals = filterByPeriod(snapshot.data.deals, range.from, range.to);
  const kpi = computeKpi(periodDeals, stageIndex);
  const funnel = computeFunnel(periodDeals, stageIndex);
  const recent = computeRecent(periodDeals, stageIndex, usersIndex, 20);
  return {
    ok: true,
    period: { key: range.key, ...isoRange(range) },
    kpi,
    funnel,
    recent,
    totals: {
      found: periodDeals.length,
      snapshot: snapshot.data.deals.length,
    },
  };
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  // --- /api/dashboard ------------------------------------------------------
  if (url.pathname === "/api/dashboard") {
    const period = url.searchParams.get("period") || "month";
    const from = url.searchParams.get("from") || null;
    const to = url.searchParams.get("to") || null;
    const meta = {
      updatedAt: snapshot.at ? new Date(snapshot.at).toISOString() : null,
      ageMs: snapshot.at ? Date.now() - snapshot.at : null,
      building: snapshot.building,
      warning: snapshot.error ? TEXT_BY_KIND[snapshot.error.kind] : null,
    };
    if (!snapshot.data) {
      const kind = snapshot.error?.kind ?? (KEY && BASE ? "loading" : "no_key");
      if (kind === "loading") {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Данные ещё загружаются. Портал отвечает медленно, подождите.",
            meta,
          }),
        );
        return;
      }
      res.writeHead(HTTP_BY_KIND[kind] || 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: TEXT_BY_KIND[kind], kind, meta }));
      return;
    }
    const result = buildDashboard(period, from, to);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ ...result, meta }));
    return;
  }

  // --- /api/health ---------------------------------------------------------
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        keyPresent: Boolean(KEY),
        keySource: KEY ? (KEY_FROM_ENVIRONMENT ? "environment" : ENV_FILE) : null,
        baseUrlPresent: Boolean(BASE),
        portalTimeoutMs: PORTAL_TIMEOUT_MS,
        snapshot: {
          updatedAt: snapshot.at ? new Date(snapshot.at).toISOString() : null,
          building: snapshot.building,
          lastError: snapshot.error,
          deals: snapshot.data?.deals?.length ?? null,
          stages: snapshot.data?.stages?.length ?? null,
          users: snapshot.data?.users?.length ?? null,
        },
      }),
    );
    return;
  }

  // --- /api/meta: служебные данные для фронта (домен для ссылок) ----------
  if (url.pathname === "/api/meta") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        domain: DOMAIN,
        snapshotDeals: snapshot.data?.deals?.length ?? null,
      }),
    );
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
setInterval(() => void refresh(), REFRESH_MS).unref();
