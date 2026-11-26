import './style.css';
import type {
  HandHistoryItem,
  PlayerAction,
  PokerConfig,
  PublicView,
  SessionClosed,
  SessionInfo,
  TableResponse,
} from '../shared/poker-types';
import { api, ApiError, devUserId } from './api';
import { esc, fmt, headerHtml, lobbyHtml, tableHtml, updateRaiseControls, type LobbyForm } from './view';

const root = document.querySelector<HTMLDivElement>('#app')!;

// ---------- Состояние клиента ----------

const store = {
  config: null as PokerConfig | null,
  balance: 0,
  history: [] as HandHistoryItem[],
  session: null as SessionInfo | null,
  view: null as PublicView | null,
  closed: null as SessionClosed | null,
  /** Идёт запрос или анимация ходов ботов — кнопки заблокированы. */
  busy: false,
  raiseTo: 0,
  raiseKey: '',
  confirmLeave: false,
  notice: null as string | null,
  fatal: null as string | null,
  form: { buyIn: 1000, bots: 3 } as LobbyForm,
};

/** Что уже показано — чтобы анимировать только новые карты. */
let shown = { handNo: -1, board: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Отрисовка ----------

function render() {
  let body: string;
  if (store.fatal) {
    body = `<div class="panel fatal">${esc(store.fatal)}</div>`;
  } else if (store.session && store.view) {
    const view = store.view;
    syncRaise(view);
    const newHand = view.handNo !== shown.handNo;
    body = tableHtml({
      session: store.session,
      view,
      busy: store.busy,
      raiseTo: store.raiseTo,
      closed: store.closed,
      confirmLeave: store.confirmLeave,
      dealHole: newHand,
      boardFrom: newHand ? 0 : Math.min(shown.board, view.board.length),
    });
    shown = { handNo: view.handNo, board: view.board.length };
  } else if (store.config) {
    body = lobbyHtml(store.config, store.history, store.notice, store.form, store.busy);
  } else {
    body = '<div class="loading">Загрузка…</div>';
  }
  root.innerHTML = headerHtml(store.config, store.balance, devUserId()) + `<main>${body}</main>`;
  const log = root.querySelector('.log');
  if (log) log.scrollTop = log.scrollHeight;
}

/** При новом круге торговли ставим ползунок рейза на минимум. */
function syncRaise(view: PublicView) {
  const L = view.legal;
  const key = L ? `${view.handNo}:${view.stage}:${view.currentBet}:${L.minRaiseTo}` : '';
  if (key !== store.raiseKey) {
    store.raiseKey = key;
    if (L) store.raiseTo = L.minRaiseTo;
  }
}

const toast = document.createElement('div');
toast.className = 'toast';
document.body.appendChild(toast);
let toastTimer = 0;

function showError(e: unknown) {
  toast.textContent = e instanceof Error ? e.message : String(e);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 4000);
}

// ---------- Загрузка ----------

async function loadLobby() {
  const [cfg, history] = await Promise.all([api.config(), api.history()]);
  store.config = cfg;
  store.balance = cfg.balance;
  store.history = history;
  const maxBuy = Math.min(cfg.maxBuyIn, cfg.balance);
  store.form.buyIn = Math.max(cfg.minBuyIn, Math.min(store.form.buyIn, maxBuy));
  store.form.bots = Math.min(store.form.bots, cfg.maxBots);
}

async function init() {
  render();
  try {
    const st = await api.state();
    store.balance = st.balance;
    if (st.session) {
      store.config = await api.config();
      store.session = st.session;
      store.view = st.session.view;
      // Стол восстановлен после перезагрузки — без анимации раздачи.
      shown = { handNo: st.session.view.handNo, board: st.session.view.board.length };
    } else {
      await loadLobby();
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      store.fatal = 'Сервер не знает, кто вы. Для разработки включите DEV_AUTH=true в .env или войдите в аккаунт.';
    } else if (e instanceof ApiError && e.status === 404) {
      store.fatal = `Игрок #${devUserId()} не найден. Выполните npm run db:init (создаст демо-игрока) или откройте страницу с ?user=ID.`;
    } else {
      store.fatal = `Не удалось загрузить игру: ${(e as Error).message}`;
    }
  }
  render();
}

// ---------- Ходы ----------

/** Проигрываем кадры: ходы ботов появляются по одному. */
async function playResponse(resp: TableResponse) {
  store.balance = resp.balance;
  if (resp.session) {
    let prev = store.view;
    for (let i = 0; i < resp.frames.length; i++) {
      const frame = resp.frames[i];
      store.view = frame;
      store.session = { ...resp.session, view: frame };
      render();
      if (i < resp.frames.length - 1) await sleep(frameDelay(prev, frame));
      prev = frame;
    }
    store.session = resp.session;
    store.view = resp.session.view;
  }
  store.closed = resp.closed;
}

function frameDelay(prev: PublicView | null, cur: PublicView): number {
  if (!prev || prev.handNo !== cur.handNo) return 1300; // раздача карт
  const newCards = cur.board.length - prev.board.length;
  return newCards > 0 ? 900 + newCards * 220 : 750;
}

async function run(request: () => Promise<TableResponse>) {
  if (store.busy) return;
  store.busy = true;
  store.confirmLeave = false;
  render();
  try {
    await playResponse(await request());
  } catch (e) {
    showError(e);
    // Стол мог измениться в другой вкладке — перечитываем состояние.
    if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
      const st = await api.state().catch(() => null);
      if (st) {
        store.session = st.session;
        store.view = st.session?.view ?? null;
        if (!st.session) await loadLobby().catch(() => undefined);
      }
    }
  } finally {
    store.busy = false;
    render();
  }
}

function act(action: PlayerAction) {
  return run(() => api.act(action));
}

async function leave() {
  if (store.busy) return;
  store.busy = true;
  store.confirmLeave = false;
  render();
  try {
    const resp = await api.leave();
    store.balance = resp.balance;
    const c = resp.closed;
    if (c) {
      store.notice =
        c.cashOut > 0
          ? `Вы встали из-за стола: на баланс вернулось ${fmt(c.cashOut)} (${c.profit >= 0 ? '+' : ''}${fmt(c.profit)} за сессию).`
          : 'Вы встали из-за стола без фишек.';
    }
    await toLobby();
  } catch (e) {
    showError(e);
  } finally {
    store.busy = false;
    render();
  }
}

async function toLobby() {
  if (store.closed?.reason === 'bust') {
    store.notice = `Фишки закончились: бай-ин ${fmt(store.session?.buyIn ?? 0)} проигран. Можно сесть снова.`;
  }
  store.session = null;
  store.view = null;
  store.closed = null;
  await loadLobby();
  render();
}

function setRaise(value: number) {
  const L = store.view?.legal;
  if (!L || !Number.isFinite(value)) return;
  store.raiseTo = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(value)));
  updateRaiseControls(root, store.view!, store.raiseTo);
}

function raiseNow() {
  const L = store.view?.legal;
  if (!L?.canRaise) return;
  act(store.raiseTo >= L.maxRaiseTo ? { type: 'allin' } : { type: 'raise', amount: store.raiseTo });
}

function setBuyIn(value: number) {
  const cfg = store.config;
  if (!cfg) return;
  const v = Math.max(cfg.minBuyIn, Math.min(cfg.maxBuyIn, cfg.balance, Math.round(value)));
  store.form.buyIn = v;
  const out = root.querySelector('output[name=buyInOut]');
  const range = root.querySelector<HTMLInputElement>('input[name=buyIn]');
  const hint = root.querySelector('.sit-form .hint');
  if (out) out.textContent = fmt(v);
  if (range) range.value = String(v);
  if (hint) hint.textContent = `От ${fmt(cfg.minBuyIn)} до ${fmt(cfg.maxBuyIn)} · это ${Math.round(v / cfg.bigBlind)} больших блайндов`;
}

// ---------- События ----------

root.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  switch (el.dataset.action) {
    case 'fold':
      act({ type: 'fold' });
      break;
    case 'check':
      act({ type: 'check' });
      break;
    case 'call':
      act({ type: 'call' });
      break;
    case 'raise':
      raiseNow();
      break;
    case 'preset':
      setRaise(Number(el.dataset.to));
      break;
    case 'next':
      run(api.nextHand);
      break;
    case 'leave':
      if (el.dataset.confirm) {
        store.confirmLeave = true;
        render();
      } else {
        leave();
      }
      break;
    case 'leave-yes':
      leave();
      break;
    case 'leave-no':
      store.confirmLeave = false;
      render();
      break;
    case 'to-lobby':
      toLobby().catch(showError);
      break;
    case 'buyin-preset':
      setBuyIn(Number(el.dataset.v));
      break;
  }
});

root.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'raise' || t.name === 'raiseNum') setRaise(Number(t.value));
  if (t.name === 'buyIn') setBuyIn(Number(t.value));
});

root.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'bots') {
    store.form.bots = Number(t.value);
    render();
  }
  if (t.name === 'raiseNum') t.value = String(store.raiseTo);
});

root.addEventListener('submit', (e) => {
  e.preventDefault();
  store.notice = null;
  run(() => api.sit(store.form.buyIn, store.form.bots));
});

// Горячие клавиши: F — фолд, C — чек/колл, R — рейз, Enter — следующая раздача.
// Используем e.code, чтобы работало и в русской раскладке.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || store.busy) return;
  const view = store.view;
  if (!store.session || !view) return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT') {
    if (e.key === 'Enter' && (target as HTMLInputElement).name === 'raiseNum') raiseNow();
    return;
  }
  if (view.stage === 'finished') {
    if ((e.code === 'Enter' || e.code === 'KeyN') && !store.closed) {
      e.preventDefault();
      run(api.nextHand);
    }
    return;
  }
  const L = view.legal;
  if (!L) return;
  if (e.code === 'KeyF') act({ type: 'fold' });
  else if (e.code === 'KeyC') act({ type: L.canCheck ? 'check' : 'call' });
  else if (e.code === 'KeyR') raiseNow();
});

init();
