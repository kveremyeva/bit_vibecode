import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStageIndex,
  buildUsersIndex,
  computeFunnel,
  computeKpi,
  computeRecent,
  filterByPeriod,
  resolvePeriod,
} from "../lib/calc.js";

const stages = [
  { statusId: "NEW", name: "Новая", sort: 10, semantics: null, color: "#9ecbff" },
  { statusId: "PREPARATION", name: "В работе", sort: 20, semantics: null, color: "#b3f0a1" },
  { statusId: "WON", name: "Успешно реализовано", sort: 30, semantics: "S", color: "#7bd500" },
  { statusId: "LOSE", name: "Провал", sort: 40, semantics: "F", color: "#ff5752" },
];

const users = [
  { id: 1, name: "Иван", lastName: "Петров", email: "ivan@example.com" },
  { id: 2, name: "Мария", lastName: "Сидорова", email: "maria@example.com" },
];

let idCounter = 0;
function makeDeal(amount, stageId, createdAt, responsibleId = 1, title = "Сделка") {
  idCounter += 1;
  return { id: idCounter, title, amount, stageId, responsibleId, createdAt };
}

const today = "2026-09-18T10:00:00.000Z";
const yesterday = "2026-09-17T10:00:00.000Z";
const lastMonth = "2026-08-10T10:00:00.000Z";

test("buildStageIndex: различает WON и открытые стадии", () => {
  const index = buildStageIndex(stages);
  assert.equal(index.hasDictionary, true);
  assert.equal(index.wonIds.has("WON"), true);
  assert.equal(index.wonIds.has("NEW"), false);
});

test("buildUsersIndex: индексирует по строковому id", () => {
  const index = buildUsersIndex(users);
  assert.equal(index.get("1").name, "Иван");
  assert.equal(index.has("999"), false);
});

test("filterByPeriod: включает сделки периода и отсекает вне его", () => {
  const deals = [
    makeDeal(100, "NEW", today),
    makeDeal(200, "WON", yesterday),
    makeDeal(300, "NEW", lastMonth),
  ];
  const inPeriod = filterByPeriod(
    deals,
    new Date("2026-09-17T00:00:00.000Z"),
    new Date("2026-09-18T23:59:59.999Z"),
  );
  assert.equal(inPeriod.length, 2);
});

test("computeKpi: считает суммы открытых и выигранных, средний чек", () => {
  const index = buildStageIndex(stages);
  const deals = [
    makeDeal(100, "NEW", today), // открытая
    makeDeal(250, "PREPARATION", today), // открытая
    makeDeal(1000, "WON", today), // выигранная
    makeDeal(500, "WON", today), // выигранная
    makeDeal(700, "LOSE", today), // потеряна — не наша статистика
  ];
  const kpi = computeKpi(deals, index);
  // «Открытые» в ТЗ — это «все, кроме выигранных», поэтому LOSE тоже входит.
  assert.equal(kpi.openSum, 1050);
  assert.equal(kpi.wonCount, 2);
  assert.equal(kpi.wonSum, 1500);
  assert.equal(kpi.avgCheck, 750);
});

test("computeKpi: без выигранных средний чек равен нулю", () => {
  const index = buildStageIndex(stages);
  const kpi = computeKpi([makeDeal(100, "NEW", today)], index);
  assert.equal(kpi.wonCount, 0);
  assert.equal(kpi.avgCheck, 0);
});

test("computeKpi: WON распознаётся по словарю стадий, а не только по коду", () => {
  const customStages = [
    { statusId: "C2:WON", name: "Успех (2-я воронка)", sort: 10, semantics: "S" },
    { statusId: "C2:NEW", name: "Новая (2-я воронка)", sort: 5, semantics: null },
  ];
  const index = buildStageIndex(customStages);
  const kpi = computeKpi(
    [
      makeDeal(300, "C2:WON", today),
      makeDeal(150, "C2:NEW", today),
    ],
    index,
  );
  assert.equal(kpi.openSum, 150);
  assert.equal(kpi.wonSum, 300);
  assert.equal(kpi.wonCount, 1);
});

test("computeFunnel: группирует по стадиям в порядке словаря", () => {
  const index = buildStageIndex(stages);
  const deals = [
    makeDeal(100, "WON", today),
    makeDeal(200, "NEW", today),
    makeDeal(300, "NEW", today),
    makeDeal(400, "PREPARATION", today),
  ];
  const funnel = computeFunnel(deals, index);
  assert.equal(funnel.length, 3);
  assert.equal(funnel[0].name, "Новая");
  assert.equal(funnel[0].count, 2);
  assert.equal(funnel[0].sum, 500);
  assert.equal(funnel[1].name, "В работе");
  assert.equal(funnel[1].count, 1);
  assert.equal(funnel[2].name, "Успешно реализовано");
});

test("computeRecent: сортирует новые сверху и подставляет имя ответственного", () => {
  const index = buildStageIndex(stages);
  const usersIndex = buildUsersIndex(users);
  const deals = [
    makeDeal(100, "NEW", yesterday, 2, "Старая"),
    makeDeal(200, "WON", today, 1, "Новая"),
  ];
  const recent = computeRecent(deals, index, usersIndex, 20);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].title, "Новая");
  assert.equal(recent[0].responsibleName, "Петров Иван");
  assert.equal(recent[1].title, "Старая");
  assert.equal(recent[1].responsibleName, "Сидорова Мария");
});

test("resolvePeriod: месяц покрывает весь текущий месяц", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");
  const range = resolvePeriod("month", null, null, now);
  assert.equal(range.from.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(range.to.toISOString(), "2026-09-30T23:59:59.999Z");
});

test("resolvePeriod: сегодня от полуночи до конца дня", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");
  const range = resolvePeriod("today", null, null, now);
  assert.equal(range.from.toISOString(), "2026-09-18T00:00:00.000Z");
  assert.equal(range.to.toISOString(), "2026-09-18T23:59:59.999Z");
});

test("resolvePeriod: неделя начинается с понедельника", () => {
  const now = new Date("2026-09-18T12:00:00.000Z"); // пятница
  const range = resolvePeriod("week", null, null, now);
  assert.equal(range.from.toISOString(), "2026-09-14T00:00:00.000Z");
  assert.equal(range.to.toISOString(), "2026-09-18T23:59:59.999Z");
});

test("resolvePeriod: вчера — предыдущий день", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");
  const range = resolvePeriod("yesterday", null, null, now);
  assert.equal(range.from.toISOString(), "2026-09-17T00:00:00.000Z");
  assert.equal(range.to.toISOString(), "2026-09-17T23:59:59.999Z");
});

test("resolvePeriod: произвольный период с проверкой порядка дат", () => {
  const ok = resolvePeriod(
    "custom",
    "2026-09-01T00:00:00.000Z",
    "2026-09-10T00:00:00.000Z",
    new Date(),
  );
  assert.equal(ok.from.toISOString(), "2026-09-01T00:00:00.000Z");
  const bad = resolvePeriod(
    "custom",
    "2026-09-15T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
    new Date(),
  );
  assert.equal(bad, null);
});
