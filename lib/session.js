// Извлечение сессии пользователя для запросов к порталу. Настоящая сессия —
// vibe_session_*, полученная через OAuth-флоу и хранящаяся в httpOnly-cookie
// "vibe_session" (см. /oauth/start и /oauth/callback в server.js). Также
// принимается заголовок X-Vibe-Authorization, если шлюз его передаёт.
// Значение не парсим — передаём в Authorization как есть.

export function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}

export function sessionFrom(req) {
  const header = req?.headers?.["x-vibe-authorization"];
  if (header && header.trim()) return header;
  const cookie = parseCookie(req?.headers?.cookie || "", "vibe_session");
  if (cookie) {
    const t = cookie.trim();
    return /^Bearer\s/i.test(t) ? t : `Bearer ${t}`;
  }
  return null;
}
