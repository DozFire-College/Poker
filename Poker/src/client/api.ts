import type { HandHistoryItem, PlayerAction, PokerConfig, TableResponse } from '../shared/poker-types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---- Учебная авторизация ----
// Пока в проекте нет экрана входа, сервер (с DEV_AUTH=true) берёт id игрока
// из заголовка X-User-Id. Сменить игрока: открыть страницу с ?user=2.
// Когда появится настоящий вход (cookie-сессия или JWT), этот заголовок
// можно убрать — сервер его просто проигнорирует.
const DEV_USER_KEY = 'casino.devUserId';

export function devUserId(): string {
  const fromUrl = new URLSearchParams(location.search).get('user');
  if (fromUrl && /^\d+$/.test(fromUrl)) localStorage.setItem(DEV_USER_KEY, fromUrl);
  return localStorage.getItem(DEV_USER_KEY) ?? '1';
}

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': devUserId() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Ошибка сервера (${res.status})`);
  return data as T;
}

export const api = {
  config: () => request<PokerConfig>('GET', '/api/poker/config'),
  state: () => request<TableResponse>('GET', '/api/poker/state'),
  sit: (buyIn: number, bots: number) => request<TableResponse>('POST', '/api/poker/sit', { buyIn, bots }),
  act: (action: PlayerAction) => request<TableResponse>('POST', '/api/poker/action', action),
  nextHand: () => request<TableResponse>('POST', '/api/poker/next-hand'),
  leave: () => request<TableResponse>('POST', '/api/poker/leave'),
  history: (limit = 12) => request<HandHistoryItem[]>('GET', `/api/poker/history?limit=${limit}`),
};
