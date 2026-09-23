// Клиент дашборда. Данные приходят только со своего /api/* — ключ портала
// никогда не покидает сервер.

const els = {
  statusline: document.getElementById("statusline"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  periodBar: document.getElementById("periodBar"),
  customRange: document.getElementById("customRange"),
  fromInput: document.getElementById("fromInput"),
  toInput: document.getElementById("toInput"),
  refreshBtn: document.getElementById("refreshBtn"),
  kpis: document.getElementById("kpis"),
  funnel: document.getElementById("funnel"),
  funnelHint: document.getElementById("funnelHint"),
  recentBody: document.getElementById("recentBody"),
  recentHint: document.getElementById("recentHint"),
  foot: document.getElementById("foot"),
};

const state = {
  period: "month",
  from: "",
  to: "",
  meta: null,
};

// ---------- утилиты форматирования ----------
function fmtInt(n) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
    Math.round(Number(n) || 0),
  );
}

function fmtMoney(n) {
  const value = Number(n) || 0;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

function fmtAgo(ms) {
  if (ms == null) return "";
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `${days} дн. назад`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function initials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/);
  if (!parts.length) return "?";
  return (
    parts[0][0] + (parts[1] ? parts[1][0] : "")
  ).toUpperCase();
}

function todayInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function defaultRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 6);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  return { from: fmt(start), to: fmt(end) };
}

// M5: границы периода считаем в таймзоне браузера пользователя (та же, что
// у портала для этого пользователя), а не в UTC сервера. Возвращает ISO
// с явным смещением, чтобы сервер агрегировал ровно локальные «сегодня» и
// «вчера», а не по UTC.
function localISO(date) {
  return date.toISOString();
}

function rangeForPeriod(period, from, to) {
  const now = new Date();
  if (period === "custom") {
    if (!from || !to) return null;
    const f = new Date(`${from}T00:00:00`);
    // M4: конец «до» — последняя миллисекунда локального дня, а не полночь.
    const t = new Date(`${to}T23:59:59.999`);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f > t) return null;
    return { from: localISO(f), to: localISO(t) };
  }
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let fromDate;
  if (period === "today") {
    fromDate = startOf(now);
  } else if (period === "yesterday") {
    fromDate = new Date(startOf(now).getTime() - 86_400_000);
  } else if (period === "week") {
    const dow = now.getDay(); // 0 = вс
    const offset = (dow + 6) % 7; // пн = 0
    fromDate = new Date(startOf(now).getTime() - offset * 86_400_000);
  } else if (period === "month") {
    fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    return null;
  }
  // «до» — конец сегодняшнего дня по местному времени.
  const toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { from: localISO(fromDate), to: localISO(toDate), fromDate, toDate };
}

// ---------- состояние статуса ----------
function setStatus(text, s = "wait") {
  els.statusText.textContent = text;
  els.statusline.dataset.state = s;
}

// ---------- загрузка данных ----------
async function load() {
  els.refreshBtn.classList.add("is-spinning");
  const range = rangeForPeriod(state.period, state.from, state.to);
  const params = new URLSearchParams({ period: state.period });
  if (range) {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  setStatus("Загружаю данные портала…", "wait");

  try {
    const res = await fetch(`/api/dashboard?${params}`, { cache: "no-store" });
    const json = await res.json().catch(() => null);

    if (res.status === 202) {
      setStatus(json?.error || "Портал ещё отвечает…", "wait");
      // Портал медленный: повторяем запрос через пару секунд, а не навсегда.
      window.setTimeout(() => {
        if (!document.hidden) load();
      }, 3000);
      return;
    }
    if (!res.ok) {
      setStatus(json?.error || `Ошибка ${res.status}`, "err");
      return;
    }
    if (!json.ok) {
      setStatus(json.error || "Некорректный период", "err");
      return;
    }

    state.meta = json.meta;
    render(json);
    if (json.warnings && json.warnings.length) {
      setStatus(`${json.warnings.join(" ")} Данные от ${fmtAgo(json.meta?.ageMs)}.`, "wait");
    } else if (json.meta?.warning) {
      setStatus(`${json.meta.warning} Данные от ${fmtAgo(json.meta.ageMs)}.`, "wait");
    } else {
      const tz = getTzLabel();
      setStatus(`Данные актуальны · периоды по местному времени (${tz})`, "ok");
    }
  } catch {
    setStatus("Не удалось получить данные. Проверьте соединение.", "err");
  } finally {
    els.refreshBtn.classList.remove("is-spinning");
  }
}

function getTzLabel() {
  try {
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const hh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
    const mm = String(Math.abs(offsetMin) % 60).padStart(2, "0");
    return `UTC${sign}${hh}:${mm}`;
  } catch {
    return "local";
  }
}

// ---------- отрисовка ----------
function render(json) {
  renderKpis(json.kpi);
  renderFunnel(json.funnel, json.totals);
  renderRecent(json.recent, json.totals);
  renderFoot(json);
}

function renderKpis(kpi) {
  const cards = [
    {
      label: "Сумма открытых сделок",
      value: fmtMoney(kpi.openSum),
      foot: "все сделки, кроме выигранных",
      accent: "var(--accent)",
    },
    {
      label: "Выигранных сделок",
      value: fmtInt(kpi.wonCount),
      foot: "за выбранный период",
      accent: "var(--blue)",
    },
    {
      label: "Средний чек",
      value: fmtMoney(kpi.avgCheck),
      foot: kpi.wonCount > 0 ? `${fmtInt(kpi.wonCount)} сделок · всего ${fmtMoney(kpi.wonSum)}` : "нет выигранных сделок",
      accent: "var(--amber)",
    },
  ];
  els.kpis.innerHTML = cards
    .map(
      (c) => `
      <article class="kpi" style="--kpi-accent:${c.accent}">
        <p class="kpi__label">${c.label}</p>
        <div class="kpi__value">${c.value}</div>
        <p class="kpi__foot">${escapeHtml(c.foot)}</p>
      </article>`,
    )
    .join("");
}

function renderFunnel(funnel, totals) {
  if (!funnel.length) {
    els.funnel.innerHTML = `<div class="funnel__empty">За выбранный период сделок нет — данные появятся, когда появится активность.</div>`;
    els.funnelHint.textContent = "";
    return;
  }
  const maxCount = Math.max(...funnel.map((f) => f.count), 1);
  els.funnelHint.textContent = `Сделки, созданные за период · ${fmtInt(totals?.found || 0)} шт. · сортировка по воронке`;

  const share = (value, base) => (base ? Math.round((value / base) * 100) : 0);
  els.funnel.innerHTML = funnel
    .map((f) => {
      const color = f.color || "#30d6a5";
      const width = Math.max(2, Math.round((f.count / maxCount) * 100));
      const pct = share(f.count, maxCount);
      return `
        <div class="funnel__row">
          <div class="funnel__name">${escapeHtml(f.name)}<em>${escapeHtml(f.stageId)} · ${pct}%</em></div>
          <div class="funnel__track">
            <div class="funnel__fill" style="--fill:${escapeHtml(color)};width:${width}%"></div>
          </div>
          <div class="funnel__num"><b>${fmtInt(f.count)}</b>${escapeHtml(fmtMoney(f.sum))}</div>
        </div>`;
    })
    .join("");
}

function renderRecent(recent, totals) {
  if (!recent.length) {
    els.recentBody.innerHTML = `<tr><td colspan="4"><div class="empty">За период нет сделок.</div></td></tr>`;
    els.recentHint.textContent = "";
    return;
  }
  const domain = window.__PORTAL_DOMAIN__ || "";
  els.recentHint.textContent = `Показано ${recent.length} последних · по ${fmtInt(totals?.found ?? 0)} сделкам за период · новые сверху`;
  els.recentBody.innerHTML = recent
    .map((deal) => {
      const link = domain && deal.id != null
        ? `https://${encodeURIComponent(domain)}/crm/deal/details/${deal.id}/`
        : null;
      const titleHtml = link
        ? `<a href="${link}" target="_blank" rel="noopener noreferrer">${escapeHtml(deal.title)}</a>`
        : escapeHtml(deal.title);
      const name = deal.responsibleName || "—";
      const initials2 = deal.responsibleName && deal.responsibleName !== "—" ? initials(deal.responsibleName) : "";
      return `
        <tr>
          <td>
            <div class="deal-title">
              <span>${titleHtml}</span>
              <span class="deal-meta">#${deal.id} · создана ${escapeHtml(fmtDate(deal.createdAt))}</span>
            </div>
          </td>
          <td class="deal-amount">${escapeHtml(fmtMoney(deal.amount))}</td>
          <td>
            <span class="stagetag">${escapeHtml(deal.stageName)}</span>
          </td>
          <td>
            <span class="resp">
              <span class="avatar${initials2 ? "" : " avatar--none"}">${escapeHtml(initials2)}</span>
              <span>${escapeHtml(name)}</span>
            </span>
          </td>
        </tr>`;
    })
    .join("");
}

function renderFoot(json) {
  const upd = json.meta?.updatedAt
    ? `Снимок данных: ${new Date(json.meta.updatedAt).toLocaleString("ru-RU")} (${fmtAgo(json.meta.ageMs)})`
    : "";
  const discovered = json.totals ? `· найдено за период: ${fmtInt(json.totals.found)}` : "";
  const groups = json.totals ? `· групп по стадиям: ${fmtInt(json.totals.groups)}` : "";
  els.foot.innerHTML = `
    <span class="updated">${escapeHtml(upd)}</span>
    <span>${escapeHtml(discovered)}</span>
    <span>${escapeHtml(groups)}</span>
  `;
}

// ---------- фильтр ----------
function activatePeriod(key) {
  state.period = key;
  els.periodBar.querySelectorAll(".seg").forEach((seg) => {
    seg.classList.toggle("is-active", seg.dataset.period === key);
  });
  els.customRange.hidden = key !== "custom";
  if (key === "custom") {
    if (!state.from || !state.to) {
      const range = defaultRange();
      state.from = state.from || range.from;
      state.to = state.to || range.to;
    }
    els.fromInput.value = state.from;
    els.toInput.value = state.to;
  }
  load();
}

els.periodBar.addEventListener("click", (e) => {
  const seg = e.target.closest(".seg");
  if (!seg) return;
  activatePeriod(seg.dataset.period);
});

els.fromInput.addEventListener("change", (e) => {
  state.from = e.target.value;
  load();
});

els.toInput.addEventListener("change", (e) => {
  state.to = e.target.value;
  load();
});

els.refreshBtn.addEventListener("click", () => load());

// ---------- старт ----------
function init() {
  els.fromInput.value = state.from;
  els.toInput.value = state.to;
  fetch("/api/meta")
    .then((r) => r.json())
    .then((m) => {
      if (m?.domain) window.__PORTAL_DOMAIN__ = m.domain;
    })
    .catch(() => {});
  activatePeriod("month");
}

init();
