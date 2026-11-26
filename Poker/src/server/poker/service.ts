// Покер с хранением в PostgreSQL (основной режим).
//
// Каждый запрос — одна транзакция PostgreSQL:
//   1) блокируем строку игрока (SELECT ... FOR UPDATE), чтобы два быстрых клика
//      или две вкладки не испортили баланс и состояние стола;
//   2) загружаем состояние стола из poker_sessions.state;
//   3) применяем ход игрока, боты отвечают (логика — в session.ts);
//   4) сохраняем состояние, пишем историю раздачи, деньги — через bets/transactions.
// Если на любом шаге ошибка — ROLLBACK, и ничего не меняется.

import type { Pool, PoolClient } from 'pg';
import type {
  Card,
  HandHistoryItem,
  PlayerAction,
  PokerConfig,
  PublicView,
  SessionClosed,
  TableResponse,
} from '../../shared/poker-types.js';
import { HttpError } from '../http-error.js';
import {
  checkCanSit,
  closeSummary,
  dealHand,
  ensureVersion,
  foldAndFinish,
  makeConfig,
  newSession,
  parseAction,
  playerAct,
  playerStack,
  POKER_RULES,
  sessionInfo,
  takeHandRecord,
  validateSitArgs,
  type GameLimits,
  type PokerBackend,
  type SessionState,
} from './session.js';

export { POKER_RULES };

// Для pg строки описываем через type (не interface) — так их принимает generic query<T>.
type GameRow = { id: number; min_bet: number; max_bet: number; is_active: boolean };
type UserRow = { id: number; username: string; balance: number };
type SessionRow = { id: number; bet_id: number; state: SessionState };
type HandRow = {
  id: number;
  hand_no: number;
  hole_cards: Card[];
  board: Card[];
  pot: number;
  invested: number;
  won: number;
  summary: string | null;
  created_at: Date;
};

const limitsOf = (g: GameRow): GameLimits => ({ minBuyIn: g.min_bet, maxBuyIn: g.max_bet, isActive: g.is_active });

export class PokerService implements PokerBackend {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // ---------- Публичные методы (их вызывают роуты) ----------

  async getConfig(userId: number): Promise<PokerConfig> {
    const [game, user] = await this.withClient((c) =>
      Promise.all([this.getGame(c), this.getUser(c, userId, false)]),
    );
    return makeConfig(user.username, user.balance, limitsOf(game));
  }

  async getState(userId: number): Promise<TableResponse> {
    return this.withClient(async (c) => {
      const user = await this.getUser(c, userId, false);
      const row = await this.loadSession(c, userId, false);
      return { balance: user.balance, session: row ? sessionInfo(row.id, row.state) : null, frames: [], closed: null };
    });
  }

  /** Сесть за стол: бай-ин списывается с баланса и сразу начинается первая раздача. */
  async sit(userId: number, buyIn: number, botCount: number): Promise<TableResponse> {
    validateSitArgs(buyIn, botCount);

    return this.transaction(async (c) => {
      const user = await this.getUser(c, userId, true);
      const game = await this.getGame(c);
      const seated = (await this.loadSession(c, userId, false)) !== null;
      checkCanSit(buyIn, limitsOf(game), user.balance, seated);

      // Деньги: баланс → стол.
      const balance = await this.changeBalance(c, userId, -buyIn);
      const bet = await c.query<{ id: number }>(
        `INSERT INTO bets (user_id, game_id, amount, payout, bet_data, result_data)
         VALUES ($1, $2, $3, 0, $4::jsonb, $5::jsonb) RETURNING id`,
        [
          userId,
          game.id,
          buyIn,
          JSON.stringify({
            kind: 'table_session',
            buyIn,
            bots: botCount,
            smallBlind: POKER_RULES.smallBlind,
            bigBlind: POKER_RULES.bigBlind,
          }),
          JSON.stringify({ status: 'playing' }),
        ],
      );
      const betId = bet.rows[0].id;
      await this.addTransaction(c, userId, betId, 'bet', -buyIn, balance);

      const state = newSession(user.username, buyIn, botCount);
      const inserted = await c.query<{ id: number }>(
        `INSERT INTO poker_sessions (user_id, bet_id, state) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [userId, betId, JSON.stringify(state)],
      );
      const row: SessionRow = { id: inserted.rows[0].id, bet_id: betId, state };
      return this.saveAndRespond(c, userId, row, dealHand(state));
    });
  }

  /** Ход игрока: fold / check / call / raise / allin. */
  async act(userId: number, action: PlayerAction): Promise<TableResponse> {
    const clean = parseAction(action);
    return this.transaction(async (c) => {
      await this.getUser(c, userId, true);
      const row = await this.requireSession(c, userId);
      return this.saveAndRespond(c, userId, row, playerAct(row.state, clean));
    });
  }

  async nextHand(userId: number): Promise<TableResponse> {
    return this.transaction(async (c) => {
      await this.getUser(c, userId, true);
      const row = await this.requireSession(c, userId);
      if (row.state.table.stage !== 'finished') throw new HttpError(409, 'Текущая раздача ещё не закончилась');
      const game = await this.getGame(c);
      if (!game.is_active) {
        throw new HttpError(403, 'Покер отключён администратором — можно только встать из-за стола');
      }
      return this.saveAndRespond(c, userId, row, dealHand(row.state));
    });
  }

  /** Встать из-за стола: фишки со стола возвращаются на баланс. */
  async leave(userId: number): Promise<TableResponse> {
    return this.transaction(async (c) => {
      await this.getUser(c, userId, true);
      const row = await this.requireSession(c, userId);
      const frames = foldAndFinish(row.state);
      await this.recordHand(c, userId, row);
      const closed = await this.closeSession(c, userId, row, playerStack(row.state) > 0 ? 'leave' : 'bust');
      const balance = (await this.getUser(c, userId, false)).balance;
      return { balance, session: null, frames, closed };
    });
  }

  async history(userId: number, limit = 20): Promise<HandHistoryItem[]> {
    const lim = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
    const { rows } = await this.pool.query<HandRow>(
      `SELECT id, hand_no, hole_cards, board, pot, invested, won,
              result_data->>'summary' AS summary, created_at
         FROM poker_hands
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT $2`,
      [userId, lim],
    );
    return rows.map((r) => ({
      id: r.id,
      handNo: r.hand_no,
      holeCards: r.hole_cards,
      board: r.board,
      pot: r.pot,
      invested: r.invested,
      won: r.won,
      summary: r.summary ?? '',
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  // ---------- Внутренние шаги ----------

  /**
   * Общий конец запроса: если раздача закончилась — пишем её в историю;
   * если у игрока не осталось фишек — закрываем сессию; иначе сохраняем стол.
   */
  private async saveAndRespond(c: PoolClient, userId: number, row: SessionRow, frames: PublicView[]): Promise<TableResponse> {
    let closed: SessionClosed | null = null;
    if (await this.recordHand(c, userId, row)) {
      if (playerStack(row.state) === 0) closed = await this.closeSession(c, userId, row, 'bust');
    }
    if (!closed) {
      await c.query(`UPDATE poker_sessions SET state = $2::jsonb, updated_at = now() WHERE id = $1`, [
        row.id,
        JSON.stringify(row.state),
      ]);
    }
    const balance = (await this.getUser(c, userId, false)).balance;
    return { balance, session: sessionInfo(row.id, row.state), frames, closed };
  }

  /** Записывает закончившуюся раздачу в poker_hands. Возвращает true, если запись была. */
  private async recordHand(c: PoolClient, userId: number, row: SessionRow): Promise<boolean> {
    const rec = takeHandRecord(row.state);
    if (!rec) return false;
    await c.query(
      `INSERT INTO poker_hands (session_id, user_id, hand_no, hole_cards, board, pot, invested, won, result_data)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb)`,
      [
        row.id,
        userId,
        rec.handNo,
        JSON.stringify(rec.holeCards),
        JSON.stringify(rec.board),
        rec.pot,
        rec.invested,
        rec.won,
        JSON.stringify(rec.resultData),
      ],
    );
    return true;
  }

  /** Деньги: стол → баланс. Закрывает ставку в bets и сессию. */
  private async closeSession(
    c: PoolClient,
    userId: number,
    row: SessionRow,
    reason: SessionClosed['reason'],
  ): Promise<SessionClosed> {
    const { closed, betResult } = closeSummary(row.state, reason);
    if (closed.cashOut > 0) {
      const balance = await this.changeBalance(c, userId, closed.cashOut);
      await this.addTransaction(c, userId, row.bet_id, 'win', closed.cashOut, balance);
    }
    await c.query(`UPDATE bets SET payout = $2, result_data = $3::jsonb WHERE id = $1`, [
      row.bet_id,
      closed.cashOut,
      JSON.stringify(betResult),
    ]);
    await c.query(
      `UPDATE poker_sessions
          SET status = 'closed', state = $2::jsonb, updated_at = now(), closed_at = now()
        WHERE id = $1`,
      [row.id, JSON.stringify(row.state)],
    );
    return closed;
  }

  // ---------- Работа с БД ----------

  /** Одно подключение из пула без транзакции — для чтения. */
  private async withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private async transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async getGame(db: PoolClient): Promise<GameRow> {
    const { rows } = await db.query<GameRow>(
      'SELECT id, min_bet, max_bet, is_active FROM games WHERE code = $1',
      [POKER_RULES.gameCode],
    );
    if (!rows[0]) throw new HttpError(500, 'В таблице games нет игры poker — выполните npm run db:init');
    return rows[0];
  }

  /** forUpdate = true блокирует строку игрока до конца транзакции. */
  private async getUser(db: PoolClient, userId: number, forUpdate: boolean): Promise<UserRow> {
    const { rows } = await db.query<UserRow>(
      `SELECT id, username, balance FROM users WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [userId],
    );
    if (!rows[0]) throw new HttpError(404, 'Пользователь не найден');
    return rows[0];
  }

  private async loadSession(db: PoolClient, userId: number, forUpdate: boolean): Promise<SessionRow | null> {
    const { rows } = await db.query<SessionRow>(
      `SELECT id, bet_id, state FROM poker_sessions
        WHERE user_id = $1 AND status = 'active'${forUpdate ? ' FOR UPDATE' : ''}`,
      [userId],
    );
    return rows[0] ?? null;
  }

  private async requireSession(c: PoolClient, userId: number): Promise<SessionRow> {
    const row = await this.loadSession(c, userId, true);
    if (!row) throw new HttpError(404, 'Вы не сидите за столом');
    ensureVersion(row.state);
    return row;
  }

  private async changeBalance(c: PoolClient, userId: number, delta: number): Promise<number> {
    const { rows } = await c.query<{ balance: number }>(
      'UPDATE users SET balance = balance + $2 WHERE id = $1 RETURNING balance',
      [userId, delta],
    );
    return rows[0].balance;
  }

  private async addTransaction(
    c: PoolClient,
    userId: number,
    betId: number,
    type: 'bet' | 'win',
    amount: number,
    balanceAfter: number,
  ): Promise<void> {
    await c.query(
      `INSERT INTO transactions (user_id, bet_id, type, amount, balance_after) VALUES ($1, $2, $3, $4, $5)`,
      [userId, betId, type, amount, balanceAfter],
    );
  }
}
