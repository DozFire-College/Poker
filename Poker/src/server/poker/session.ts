// Логика игровой сессии (посадка, ходы, конец раздачи, выход) без привязки к хранилищу.
// Её используют оба варианта сервиса:
//   • service.ts        — PostgreSQL (основной режим);
//   • memory-service.ts — всё в памяти (демо-режим без базы).
// Хранилище отвечает только за деньги, блокировки и запись истории.

import type {
  ActionType,
  Card,
  HandHistoryItem,
  PlayerAction,
  PokerConfig,
  PublicView,
  SessionClosed,
  SessionInfo,
  SessionStats,
  TableResponse,
} from '../../shared/poker-types.js';
import { HttpError } from '../http-error.js';
import { BOT_PROFILES, playBotsUntilHuman } from './bot.js';
import {
  applyAction,
  buildView,
  createTable,
  PokerRuleError,
  startHand,
  STYLE_LABELS,
  totalPot,
  type TableState,
} from './engine.js';

export const POKER_RULES = {
  gameCode: 'poker',
  smallBlind: 5,
  bigBlind: 10,
  maxBots: BOT_PROFILES.length,
} as const;

/** Что умеет любой вариант сервиса покера (его вызывают роуты). */
export interface PokerBackend {
  getConfig(userId: number): Promise<PokerConfig>;
  getState(userId: number): Promise<TableResponse>;
  sit(userId: number, buyIn: number, botCount: number): Promise<TableResponse>;
  act(userId: number, action: PlayerAction): Promise<TableResponse>;
  nextHand(userId: number): Promise<TableResponse>;
  leave(userId: number): Promise<TableResponse>;
  history(userId: number, limit?: number): Promise<HandHistoryItem[]>;
}

/** Состояние сессии (в PostgreSQL лежит в poker_sessions.state). */
export interface SessionState {
  version: 1;
  table: TableState;
  /** Индекс места живого игрока (всегда 0, но так понятнее). */
  playerIndex: number;
  buyIn: number;
  stats: SessionStats;
  /** Номер последней раздачи, уже записанной в историю. */
  lastRecordedHand: number;
}

/** Данные одной раздачи для истории (таблица poker_hands). */
export interface HandRecord {
  handNo: number;
  holeCards: Card[];
  board: Card[];
  pot: number;
  invested: number;
  won: number;
  resultData: {
    summary: string;
    showdown: boolean;
    pots: { amount: number; winners: string[]; hand: string | null }[];
    shownCards: Record<string, Card[]>;
    playerFolded: boolean;
    playerHand: string | null;
  };
}

export interface GameLimits {
  minBuyIn: number;
  maxBuyIn: number;
  isActive: boolean;
}

const ACTIONS: ActionType[] = ['fold', 'check', 'call', 'raise', 'allin'];

export function viewOf(state: SessionState): PublicView {
  return buildView(state.table, state.playerIndex);
}

/** Ошибки правил игры превращаем в ответ 400 с понятным текстом. */
function rules<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PokerRuleError) throw new HttpError(400, e.message);
    throw e;
  }
}

export function botList(): PokerConfig['bots'] {
  return BOT_PROFILES.map((b) => ({ name: b.name, style: STYLE_LABELS[b.style] }));
}

export function makeConfig(username: string, balance: number, limits: GameLimits, demoMode = false): PokerConfig {
  return {
    username,
    balance,
    minBuyIn: limits.minBuyIn,
    maxBuyIn: limits.maxBuyIn,
    smallBlind: POKER_RULES.smallBlind,
    bigBlind: POKER_RULES.bigBlind,
    maxBots: POKER_RULES.maxBots,
    isActive: limits.isActive,
    bots: botList(),
    demoMode,
  };
}

/** Проверка аргументов до обращения к хранилищу. */
export function validateSitArgs(buyIn: number, botCount: number): void {
  if (!Number.isInteger(buyIn)) throw new HttpError(400, 'Бай-ин должен быть целым числом');
  if (!Number.isInteger(botCount) || botCount < 1 || botCount > POKER_RULES.maxBots) {
    throw new HttpError(400, `Соперников может быть от 1 до ${POKER_RULES.maxBots}`);
  }
}

/** Можно ли сесть за стол — проверки в том же порядке для обоих хранилищ. */
export function checkCanSit(buyIn: number, limits: GameLimits, balance: number, alreadySeated: boolean): void {
  if (!limits.isActive) throw new HttpError(403, 'Покер сейчас отключён администратором');
  if (buyIn < limits.minBuyIn || buyIn > limits.maxBuyIn) {
    throw new HttpError(400, `Бай-ин должен быть от ${limits.minBuyIn} до ${limits.maxBuyIn}`);
  }
  if (alreadySeated) throw new HttpError(409, 'Вы уже сидите за столом');
  if (balance < buyIn) throw new HttpError(400, 'Недостаточно фишек на балансе');
}

export function parseAction(action: PlayerAction | undefined): PlayerAction {
  if (!action || !ACTIONS.includes(action.type)) throw new HttpError(400, 'Неизвестное действие');
  return action.type === 'raise' ? { type: 'raise', amount: Number(action.amount) } : { type: action.type };
}

/** Новый стол: игрок на месте 0, боты получают такой же стек. */
export function newSession(username: string, buyIn: number, botCount: number): SessionState {
  const table = createTable({
    smallBlind: POKER_RULES.smallBlind,
    bigBlind: POKER_RULES.bigBlind,
    seats: [
      { id: 'player', name: username, isBot: false, stack: buyIn },
      ...BOT_PROFILES.slice(0, botCount).map((b, i) => ({
        id: `bot${i + 1}`,
        name: b.name,
        isBot: true,
        style: b.style,
        stack: buyIn,
      })),
    ],
  });
  return {
    version: 1,
    table,
    playerIndex: 0,
    buyIn,
    stats: { handsPlayed: 0, handsWon: 0, biggestPot: 0 },
    lastRecordedHand: 0,
  };
}

export function ensureVersion(state: SessionState): void {
  if (state.version !== 1) throw new HttpError(500, 'Неизвестная версия состояния стола');
}

/** Новая раздача + ходы ботов до очереди игрока. Возвращает кадры для анимации. */
export function dealHand(state: SessionState): PublicView[] {
  if (state.table.stage !== 'finished') throw new HttpError(409, 'Текущая раздача ещё не закончилась');
  const frames: PublicView[] = [];
  rules(() => startHand(state.table, { rebuyBotsTo: state.buyIn }));
  frames.push(viewOf(state));
  playBotsUntilHuman(state.table, () => frames.push(viewOf(state)));
  return frames;
}

/** Ход игрока и ответы ботов. */
export function playerAct(state: SessionState, action: PlayerAction): PublicView[] {
  const frames: PublicView[] = [];
  rules(() => applyAction(state.table, state.playerIndex, action));
  frames.push(viewOf(state));
  playBotsUntilHuman(state.table, () => frames.push(viewOf(state)));
  return frames;
}

/**
 * Игрок встаёт посреди раздачи: карты сбрасываются, поставленное остаётся в банке,
 * боты доигрывают раздачу между собой.
 */
export function foldAndFinish(state: SessionState): PublicView[] {
  if (state.table.stage === 'finished') return [];
  return playerAct(state, { type: 'fold' });
}

export function playerStack(state: SessionState): number {
  return state.table.seats[state.playerIndex].stack;
}

/**
 * Если раздача закончилась и ещё не записана — возвращает запись для истории
 * и обновляет статистику сессии. Иначе null.
 */
export function takeHandRecord(state: SessionState): HandRecord | null {
  const t = state.table;
  const result = t.result;
  if (t.stage !== 'finished' || !result || t.handNo <= state.lastRecordedHand) return null;
  const me = t.seats[state.playerIndex];
  const nameOf = (id: string) => t.seats.find((s) => s.id === id)?.name ?? id;

  state.lastRecordedHand = t.handNo;
  state.stats.handsPlayed += 1;
  if (me.won > me.totalBet) state.stats.handsWon += 1;
  state.stats.biggestPot = Math.max(state.stats.biggestPot, me.won);

  return {
    handNo: t.handNo,
    holeCards: [...me.hole],
    board: [...t.board],
    pot: totalPot(t),
    invested: me.totalBet,
    won: me.won,
    resultData: {
      summary: result.summary,
      showdown: result.showdown,
      pots: result.pots.map((p) => ({ amount: p.amount, winners: p.winners.map(nameOf), hand: p.handName })),
      // На вскрытии карты открыты всем — их можно сохранить.
      shownCards: result.showdown
        ? Object.fromEntries(t.seats.filter((s) => s.inHand && !s.folded).map((s) => [s.name, [...s.hole]]))
        : {},
      playerFolded: me.folded,
      playerHand: result.handNames[me.id] ?? null,
    },
  };
}

/** Итог сессии при выходе или проигрыше: что вернуть на баланс и что записать в bets.result_data. */
export function closeSummary(state: SessionState, reason: SessionClosed['reason']) {
  const cashOut = playerStack(state);
  const closed: SessionClosed = { reason, cashOut, profit: cashOut - state.buyIn };
  const betResult = { status: 'closed', reason, finalStack: cashOut, profit: closed.profit, ...state.stats };
  return { closed, betResult };
}

export function sessionInfo(id: number, state: SessionState): SessionInfo {
  return { id, buyIn: state.buyIn, stats: state.stats, view: viewOf(state) };
}
