import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

// Дублируем лёгкую проверку PKCE-логики: code_challenge должен быть
// base64url(sha256(code_verifier)) — именно так валидирует сервер.
function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

test("PKCE: code_challenge = S256(code_verifier)", () => {
  const verifier = base64url(Buffer.alloc(48, 7));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redo =
    base64url(createHash("sha256").update(verifier).digest()) === challenge;
  assert.equal(redo, true);
});

test("base64url verifier: 48 случайных байт дают корректную длину", () => {
  const v = base64url(randomBytes(48));
  assert.equal(v.length, 64);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(v));
});
