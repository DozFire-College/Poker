// Демо-режим без базы данных: балансы, столы и история хранятся в памяти процесса Node.js.
// Нужен, чтобы посмотреть и проверить игру, пока не установлен PostgreSQL.
// При перезапуске сервера всё сбрасывается. Игровая логика та же (session.ts),
// что и в режиме с базой, отличается только хранилище.

import type { HandHistoryItem, PlayerAction, PokerConfig, PublicView, SessionClosed, TableResponse } from '../../shared/poker-types.js';
import { HttpError } from '../http-error.js';
import {
  checkCanSit,
  closeSummary,
  dealHand,
  foldAndFinish,
  makeConfig,
  newSession,
  parseAction,
  playerAct,
  playerStack,
  sessionInfo,
  takeHandRecord,
  validateSitArgs,
  type GameLimits,
  type HandRecord,
  type PokerBackend,
  type SessionState,
} from './session.js';

export const MEMORY_START_BALANCE = 10000;

interface MemUser {
  id: number;
  username: string;
  balance: number;
}

interface MemSession {
  id: number;
  state: SessionState;
}

interface MemHand extends HandRecord {
  id: number;
  createdAt: string;
}

export class MemoryPokerService implements PokerBackend {
  /** Те же лимиты, что в db/02_poker.sql. */
  readonly limits: GameLimits = { minBuyIn: 200, maxBuyIn: 2000, isActive: true };

  private readonly users = new Map<number, MemUser>();
  private readonly sessions = new Map<number, MemSession>();
  private readonly hands = new Map<number, MemHand[]>();
  private nextSessionId = 1;
  private nextHandId = 1;

  async getConfig(userId: number): Promise<PokerConfig> {
    const u = this.user(userId);
    return makeConfig(u.username, u.balance, this.limits, true);
  }

  async getState(userId: number): Promise<TableResponse> {
    const u = this.user(userId);
    const s = this.sessions.get(userId);
    return { balance: u.balance, session: s ? sessionInfo(s.id, s.state) : null, frames: [], closed: null };
  }

  async sit(userId: number, buyIn: number, botCount: number): Promise<TableResponse> {
    validateSitArgs(buyIn, botCount);
    const u = this.user(userId);
    checkCanSit(buyIn, this.limits, u.balance, this.sessions.has(userId));
    // Сначала готовим стол, и только если всё прошло без ошибок — списываем бай-ин.
    const state = newSession(u.username, buyIn, botCount);
    const frames = dealHand(state);
    u.balance -= buyIn;
    const s: MemSession = { id: this.nextSessionId++, state };
    this.sessions.set(userId, s);
    return this.respond(u, s, frames);
  }

  async act(userId: number, action: PlayerAction): Promise<TableResponse> {
    const clean = parseAction(action);
    return this.change(userId, (state) => playerAct(state, clean));
  }

  async nextHand(userId: number): Promise<TableResponse> {
    return this.change(userId, (state) => {
      if (state.table.stage !== 'finished') throw new HttpError(409, 'Текущая раздача ещё не закончилась');
      if (!this.limits.isActive) {
        throw new HttpError(403, 'Покер отключён администратором — можно только встать из-за стола');
      }
      return dealHand(state);
    });
  }

  async leave(userId: number): Promise<TableResponse> {
    const u = this.user(userId);
    const s = this.requireSession(userId);
    const draft = structuredClone(s.state);
    const frames = foldAndFinish(draft);
    s.state = draft;
    this.record(userId, s);
    const closed = this.close(u, s, playerStack(s.state) > 0 ? 'leave' : 'bust');
    return { balance: u.balance, session: null, frames, closed };
  }

  async history(userId: number, limit = 20): Promise<HandHistoryItem[]> {
    const lim = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
    return (this.hands.get(userId) ?? []).slice(0, lim).map((h) => ({
      id: h.id,
      handNo: h.handNo,
      holeCards: h.holeCards,
      board: h.board,
      pot: h.pot,
      invested: h.invested,
      won: h.won,
      summary: h.resultData.summary,
      createdAt: h.createdAt,
    }));
  }

  // ---------- Внутреннее ----------

  /** Игрок создаётся при первом обращении: id 1 — demo, остальные — «игрокN». */
  private user(userId: number): MemUser {
    let u = this.users.get(userId);
    if (!u) {
      u = { id: userId, username: userId === 1 ? 'demo' : `игрок${userId}`, balance: MEMORY_START_BALANCE };
      this.users.set(userId, u);
    }
    return u;
  }

  private requireSession(userId: number): MemSession {
    const s = this.sessions.get(userId);
    if (!s) throw new HttpError(404, 'Вы не сидите за столом');
    return s;
  }

  /**
   * Изменение стола «как транзакция»: работаем с копией состояния и сохраняем
   * её, только если не было ошибки.
   */
  private change(userId: number, fn: (state: SessionState) => PublicView[]): TableResponse {
    const u = this.user(userId);
    const s = this.requireSession(userId);
    const draft = structuredClone(s.state);
    const frames = fn(draft);
    s.state = draft;
    return this.respond(u, s, frames);
  }

  private respond(u: MemUser, s: MemSession, frames: PublicView[]): TableResponse {
    let closed: SessionClosed | null = null;
    if (this.record(u.id, s) && playerStack(s.state) === 0) closed = this.close(u, s, 'bust');
    return { balance: u.balance, session: sessionInfo(s.id, s.state), frames, closed };
  }

  private record(userId: number, s: MemSession): boolean {
    const rec = takeHandRecord(s.state);
    if (!rec) return false;
    const list = this.hands.get(userId) ?? [];
    list.unshift({ ...rec, id: this.nextHandId++, createdAt: new Date().toISOString() });
    if (list.length > 200) list.length = 200;
    this.hands.set(userId, list);
    return true;
  }

  private close(u: MemUser, s: MemSession, reason: SessionClosed['reason']): SessionClosed {
    const { closed } = closeSummary(s.state, reason);
    u.balance += closed.cashOut;
    this.sessions.delete(u.id);
    return closed;
  }
}
