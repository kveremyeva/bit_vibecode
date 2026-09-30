// Извлечение сессии шлюза для запросов к порталу. Сессия приходит либо
// заголовком X-Vibe-Authorization, либо (в нашем шлюзе) cookie _vibe_gw с JWT.
// Значение не парсим (JWT разбирает прокси) — передаём в Authorization.

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
  const cookie = parseCookie(req?.headers?.cookie || "", "_vibe_gw");
  if (cookie) {
    const t = cookie.trim();
    return /^Bearer\s/i.test(t) ? t : `Bearer ${t}`;
  }
  return null;
}
