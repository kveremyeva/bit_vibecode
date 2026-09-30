import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCookie, sessionFrom } from "../lib/session.js";

test("parseCookie: достаёт значение по имени из строки cookies", () => {
  const header = "_vibe_gw=eyJhbGciOiJIUzI1NiJ9; other=1; theme=dark";
  assert.equal(parseCookie(header, "_vibe_gw"), "eyJhbGciOiJIUzI1NiJ9");
  assert.equal(parseCookie(header, "theme"), "dark");
  assert.equal(parseCookie(header, "missing"), null);
  assert.equal(parseCookie("", "_vibe_gw"), null);
  assert.equal(parseCookie(null, "_vibe_gw"), null);
});

test("sessionFrom: берёт сессию из заголовка X-Vibe-Authorization как есть", () => {
  const s = sessionFrom({ headers: { "x-vibe-authorization": "Bearer vibe_session_x" } });
  assert.equal(s, "Bearer vibe_session_x");
});

test("sessionFrom: fallback на cookie _vibe_gw, добавляет Bearer к голому JWT", () => {
  const s = sessionFrom({
    headers: { cookie: "_vibe_gw=eyJhdXRoIjoidG9rZW4ifQ; a=1" },
  });
  assert.equal(s, "Bearer eyJhdXRoIjoidG9rZW4ifQ");
});

test("sessionFrom: если cookie уже со схемой Bearer — оставляет как есть", () => {
  const s = sessionFrom({
    headers: { cookie: "_vibe_gw=Bearer%20eyJtZXNzYWdlIjoiaGkifQ" },
  });
  assert.equal(s, "Bearer eyJtZXNzYWdlIjoiaGkifQ");
});

test("sessionFrom: без заголовка и без cookie — null", () => {
  assert.equal(sessionFrom({ headers: {} }), null);
  assert.equal(sessionFrom({ headers: { cookie: "a=1" } }), null);
});
