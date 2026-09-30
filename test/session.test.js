import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCookie, sessionFrom } from "../lib/session.js";

test("parseCookie: достаёт значение по имени из строки cookies", () => {
  const header = "vibe_session=eyJhbGciOiJIUzI1NiJ9; other=1; theme=dark";
  assert.equal(parseCookie(header, "vibe_session"), "eyJhbGciOiJIUzI1NiJ9");
  assert.equal(parseCookie(header, "theme"), "dark");
  assert.equal(parseCookie(header, "missing"), null);
  assert.equal(parseCookie("", "vibe_session"), null);
  assert.equal(parseCookie(null, "vibe_session"), null);
});

test("sessionFrom: берёт сессию из заголовка X-Vibe-Authorization как есть", () => {
  const s = sessionFrom({ headers: { "x-vibe-authorization": "Bearer vibe_session_x" } });
  assert.equal(s, "Bearer vibe_session_x");
});

test("sessionFrom: читает vibe_session из cookie, добавляет Bearer к голому токену", () => {
  const s = sessionFrom({
    headers: { cookie: "vibe_session=eyJhdXRoIjoidG9rZW4ifQ; a=1" },
  });
  assert.equal(s, "Bearer eyJhdXRoIjoidG9rZW4ifQ");
});

test("sessionFrom: если cookie уже со схемой Bearer — оставляет как есть", () => {
  const s = sessionFrom({
    headers: { cookie: "vibe_session=Bearer%20eyJtZXNzYWdlIjoiaGkifQ" },
  });
  assert.equal(s, "Bearer eyJtZXNzYWdlIjoiaGkifQ");
});

test("sessionFrom: без заголовка и без cookie — null", () => {
  assert.equal(sessionFrom({ headers: {} }), null);
  assert.equal(sessionFrom({ headers: { cookie: "a=1" } }), null);
});
