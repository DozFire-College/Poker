import type { Request } from 'express';
import { HttpError } from './http-error.js';

/**
 * Откуда берётся id игрока.
 *
 * 1) Если в проекте уже есть авторизация и её middleware кладёт пользователя
 *    в req.user (как делают passport, express-session + свой код, JWT-middleware) —
 *    используется он. Это основной вариант.
 *
 * 2) Учебная заглушка для разработки: при DEV_AUTH=true в .env id берётся
 *    из заголовка X-User-Id. Так можно проверить покер без экрана входа.
 *    НИКОГДА не включайте DEV_AUTH на настоящем сервере: любой сможет
 *    играть за любого пользователя.
 */
export function getUserId(req: Request): number {
  const fromAuth = (req as Request & { user?: { id?: unknown } }).user?.id;
  if (typeof fromAuth === 'number' && Number.isInteger(fromAuth)) return fromAuth;

  if (process.env.DEV_AUTH === 'true') {
    const id = Number(req.header('x-user-id'));
    if (Number.isInteger(id) && id > 0) return id;
  }
  throw new HttpError(401, 'Нужно войти в аккаунт');
}
