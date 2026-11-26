// Функции, которые превращают состояние в HTML-разметку.
// Никакой логики игры здесь нет — только отображение того, что прислал сервер.

import type {
  Card,
  HandHistoryItem,
  LastAction,
  LegalActions,
  PokerConfig,
  PublicSeat,
  PublicView,
  SessionClosed,
  SessionInfo,
} from '../shared/poker-types';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const fmt = (n: number) => n.toLocaleString('ru-RU');

const SUIT_SYMBOL: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const rankText = (card: Card) => (card[0] === 'T' ? '10' : card[0]);
const isRed = (card: Card) => card[1] === 'h' || card[1] === 'd';

// ---------- Карты ----------

interface CardOpts {
  size?: 'sm' | 'md' | 'lg';
  /** Подсветить (карта из выигрышной комбинации). */
  hl?: boolean;
  /** Задержка анимации раздачи в мс; null — без анимации. */
  deal?: number | null;
  dim?: boolean;
}

export function cardHtml(card: Card | null, o: CardOpts = {}): string {
  const cls = ['card', o.size ?? 'md'];
  let style = '';
  if (o.deal != null) {
    cls.push('deal');
    style = ` style="--d:${o.deal}ms"`;
  }
  if (o.dim) cls.push('dim');
  if (!card) return `<div class="${cls.join(' ')} back"${style}></div>`;
  if (isRed(card)) cls.push('red');
  if (o.hl) cls.push('hl');
  const suit = SUIT_SYMBOL[card[1]];
  return `<div class="${cls.join(' ')}"${style} title="${rankText(card)}${suit}">
    <span class="corner">${rankText(card)}<i>${suit}</i></span><span class="pip">${suit}</span></div>`;
}

/** Карты строкой — для таблицы истории. */
export function miniCards(cards: Card[]): string {
  if (cards.length === 0) return '<span class="muted">—</span>';
  return cards
    .map((c) => `<span class="mini ${isRed(c) ? 'red' : ''}">${rankText(c)}${SUIT_SYMBOL[c[1]]}</span>`)
    .join('');
}

// ---------- Шапка ----------

export function headerHtml(cfg: PokerConfig | null, balance: number, devId: string): string {
  return `
  <header class="topbar">
    <div class="brand"><span class="logo">♠</span> Казино <span class="sep">/</span> <b>Покер</b></div>
    <div class="wallet">
      ${cfg ? `<span class="user">${esc(cfg.username)}</span>` : ''}
      <span class="balance" title="Баланс вне стола"><i class="chip"></i>${fmt(balance)}</span>
      <span class="dev" title="Учебный вход: смените игрока параметром ?user=ID">dev #${esc(devId)}</span>
    </div>
  </header>`;
}

// ---------- Лобби ----------

export interface LobbyForm {
  buyIn: number;
  bots: number;
}

export function lobbyHtml(
  cfg: PokerConfig,
  history: HandHistoryItem[],
  notice: string | null,
  form: LobbyForm,
  busy: boolean,
): string {
  const maxBuy = Math.min(cfg.maxBuyIn, cfg.balance);
  const canSit = cfg.isActive && cfg.balance >= cfg.minBuyIn;
  const bb = cfg.bigBlind;

  let blocker = '';
  if (!cfg.isActive) blocker = 'Покер временно отключён администратором.';
  else if (cfg.balance < cfg.minBuyIn) blocker = `Недостаточно фишек: минимальный бай-ин ${fmt(cfg.minBuyIn)}.`;

  const botButtons = Array.from({ length: cfg.maxBots }, (_, i) => i + 1)
    .map(
      (n) => `<label class="seg-item ${n === form.bots ? 'on' : ''}">
        <input type="radio" name="bots" value="${n}" ${n === form.bots ? 'checked' : ''}>${n}</label>`,
    )
    .join('');

  const opponents = cfg.bots
    .slice(0, form.bots)
    .map((b) => `<span class="opp"><b>${esc(b.name)}</b> ${esc(b.style)}</span>`)
    .join('');

  const presets = [
    [cfg.minBuyIn, 'Мин'],
    [100 * bb, `${100} ББ`],
    [maxBuy, 'Макс'],
  ]
    .filter(([v]) => (v as number) >= cfg.minBuyIn && (v as number) <= maxBuy)
    .map(([v, label]) => `<button type="button" class="chip-btn" data-action="buyin-preset" data-v="${v}">${label}</button>`)
    .join('');

  return `
  <section class="lobby">
    ${
      cfg.demoMode
        ? `<div class="notice demo"><b>Демо-режим без базы данных.</b> Баланс и история хранятся в памяти сервера
           и сбросятся при его перезапуске. Чтобы играть с PostgreSQL, запустите <code>npm run dev</code>.</div>`
        : ''
    }
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    <div class="panel hero">
      <div class="hero-text">
        <h1>Техасский холдем</h1>
        <p class="lead">No-Limit, блайнды ${cfg.smallBlind}/${bb}. Соперники — боты с разным характером.
        Бай-ин списывается с баланса, а когда вы встаёте из-за стола, фишки возвращаются.</p>
      </div>
      ${
        blocker
          ? `<p class="blocker">${blocker}</p>`
          : `<form class="sit-form" data-form="sit">
        <div class="field">
          <div class="field-head"><span>Бай-ин</span><output name="buyInOut">${fmt(form.buyIn)}</output></div>
          <input type="range" name="buyIn" min="${cfg.minBuyIn}" max="${maxBuy}" step="10" value="${form.buyIn}">
          <div class="presets">${presets}</div>
          <div class="hint">От ${fmt(cfg.minBuyIn)} до ${fmt(cfg.maxBuyIn)} · это ${Math.round(form.buyIn / bb)} больших блайндов</div>
        </div>
        <div class="field">
          <div class="field-head"><span>Соперники</span></div>
          <div class="seg">${botButtons}</div>
          <div class="opps">${opponents}</div>
        </div>
        <button class="btn primary big" type="submit" ${canSit && !busy ? '' : 'disabled'}>Сесть за стол</button>
      </form>`
      }
    </div>
    <div class="panel">
      <h2>Последние раздачи</h2>
      ${historyHtml(history)}
    </div>
  </section>`;
}

function historyHtml(items: HandHistoryItem[]): string {
  if (items.length === 0) return '<p class="muted">Вы ещё не играли. Садитесь за стол!</p>';
  const rows = items
    .map((h) => {
      const profit = h.won - h.invested;
      const cls = profit > 0 ? 'plus' : profit < 0 ? 'minus' : '';
      return `<tr>
        <td class="muted">${new Date(h.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${miniCards(h.holeCards)}</td>
        <td>${miniCards(h.board)}</td>
        <td>${fmt(h.pot)}</td>
        <td class="${cls}">${profit > 0 ? '+' : ''}${fmt(profit)}</td>
        <td class="summary">${esc(h.summary)}</td>
      </tr>`;
    })
    .join('');
  return `<div class="table-scroll"><table class="history">
    <thead><tr><th>Когда</th><th>Карты</th><th>Борд</th><th>Банк</th><th>Итог</th><th>Результат</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------- Стол ----------

export interface TableCtx {
  session: SessionInfo;
  view: PublicView;
  busy: boolean;
  raiseTo: number;
  closed: SessionClosed | null;
  confirmLeave: boolean;
  /** Анимировать раздачу карманных карт. */
  dealHole: boolean;
  /** С какой карты борда начинать анимацию. */
  boardFrom: number;
}

function actionBadge(a: LastAction): string {
  const map: Record<LastAction['kind'], [string, string]> = {
    fold: ['Фолд', 'fold'],
    check: ['Чек', 'calm'],
    call: [`Колл ${fmt(a.amount)}`, 'calm'],
    bet: [`Бет ${fmt(a.amount)}`, 'aggr'],
    raise: [`Рейз до ${fmt(a.amount)}`, 'aggr'],
    allin: [`Олл-ин ${fmt(a.amount)}`, 'allin'],
    sb: [`МБ ${fmt(a.amount)}`, 'blind'],
    bb: [`ББ ${fmt(a.amount)}`, 'blind'],
  };
  const [text, tone] = map[a.kind];
  return `<div class="badge ${tone}">${text}</div>`;
}

/** Координаты места на овальном столе: игрок всегда внизу, остальные — по часовой стрелке. */
function seatPos(rel: number, n: number) {
  const a = ((90 + (rel * 360) / n) * Math.PI) / 180;
  return {
    x: 50 + 47 * Math.cos(a),
    y: 50 + 46 * Math.sin(a),
    bx: 50 + 30 * Math.cos(a),
    by: 50 + 27 * Math.sin(a),
  };
}

function seatHtml(s: PublicSeat, rel: number, ctx: TableCtx, highlight: Set<Card>, winner: boolean): string {
  const { view } = ctx;
  const n = view.seats.length;
  const p = seatPos(rel, n);
  const cls = ['seat'];
  if (s.isYou) cls.push('you');
  if (s.isTurn) cls.push('turn');
  if (s.folded) cls.push('folded');
  if (winner) cls.push('winner');
  if (p.y < 30) cls.push('top');

  const cards = s.cards
    .map((c, i) =>
      cardHtml(c, {
        size: s.isYou ? 'lg' : 'sm',
        hl: c != null && highlight.has(c),
        deal: ctx.dealHole ? (i * n + rel) * 90 : null,
        dim: s.isYou && s.folded,
      }),
    )
    .join('');
  const stack = s.allIn && view.stage !== 'finished' ? 'Олл-ин' : fmt(s.stack);

  return `
  <div class="${cls.join(' ')}" style="left:${p.x}%;top:${p.y}%">
    ${winner && s.won > 0 ? `<div class="won">+${fmt(s.won)}</div>` : ''}
    <div class="seat-cards">${cards}</div>
    <div class="seat-box">
      ${s.isDealer ? '<span class="dealer" title="Дилер">D</span>' : ''}
      <div class="seat-name">${esc(s.name)}${s.isYou ? ' <small>(вы)</small>' : ''}</div>
      <div class="seat-stack">${stack}</div>
      ${s.style ? `<div class="seat-style">${esc(s.style)}</div>` : ''}
      ${s.lastAction && view.stage !== 'finished' ? actionBadge(s.lastAction) : ''}
    </div>
    ${s.handName && !s.folded ? `<div class="hand-name">${esc(s.handName)}</div>` : ''}
  </div>
  ${s.bet > 0 ? `<div class="bet" style="left:${p.bx}%;top:${p.by}%"><i class="chip"></i>${fmt(s.bet)}</div>` : ''}`;
}

function raiseLabel(view: PublicView, amount: number, legal: LegalActions): string {
  if (amount >= legal.maxRaiseTo) return `Олл-ин ${fmt(amount)}`;
  return view.currentBet === 0 ? `Бет ${fmt(amount)}` : `Рейз до ${fmt(amount)}`;
}

/** Готовые размеры ставки: ½ банка и банк (рейз «до»). */
export function raisePresets(view: PublicView, legal: LegalActions): { label: string; to: number }[] {
  const clampTo = (v: number) => Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(v)));
  const afterCall = view.totalPot + legal.callAmount;
  const presets = [
    { label: 'Мин', to: legal.minRaiseTo },
    { label: '½ банка', to: clampTo(view.currentBet + afterCall / 2) },
    { label: 'Банк', to: clampTo(view.currentBet + afterCall) },
    { label: 'Олл-ин', to: legal.maxRaiseTo },
  ];
  return presets.filter((p, i) => i === 0 || p.to !== presets[i - 1].to);
}

function controlsHtml(ctx: TableCtx): string {
  const { view, busy, closed } = ctx;
  const you = view.seats.find((s) => s.isYou)!;
  if (closed?.reason === 'bust') {
    return `<div class="ctrl-msg">Фишки закончились — сессия завершена.</div>
      <button class="btn primary big" data-action="to-lobby">В лобби</button>`;
  }
  if (view.stage === 'finished') {
    return `<button class="btn primary big" data-action="next" ${busy ? 'disabled' : ''}>Следующая раздача <kbd>Enter</kbd></button>`;
  }
  const L = view.legal;
  if (!L || busy) {
    return `<div class="ctrl-msg wait">${you.folded ? 'Вы сбросили карты, соперники доигрывают' : 'Соперники думают'}<span class="dots"></span></div>`;
  }
  const callBtn = L.canCheck
    ? `<button class="btn calm" data-action="check">Чек <kbd>C</kbd></button>`
    : `<button class="btn calm" data-action="call">${L.callAmount >= you.stack ? 'Олл-ин' : 'Колл'} ${fmt(L.callAmount)} <kbd>C</kbd></button>`;

  let raise = '';
  if (L.canRaise) {
    const presets = raisePresets(view, L)
      .map((p) => `<button class="chip-btn" data-action="preset" data-to="${p.to}">${p.label}</button>`)
      .join('');
    raise = `
      <div class="raise">
        <div class="presets">${presets}</div>
        <div class="raise-row">
          <input type="range" name="raise" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" step="1" value="${ctx.raiseTo}">
          <input type="number" name="raiseNum" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" value="${ctx.raiseTo}">
        </div>
      </div>
      <button class="btn aggr" data-action="raise">${raiseLabel(view, ctx.raiseTo, L)} <kbd>R</kbd></button>`;
  }
  return `<button class="btn fold" data-action="fold">Фолд <kbd>F</kbd></button>${callBtn}${raise}`;
}

export function updateRaiseControls(root: HTMLElement, view: PublicView, amount: number) {
  const legal = view.legal;
  if (!legal) return;
  const range = root.querySelector<HTMLInputElement>('input[name=raise]');
  const num = root.querySelector<HTMLInputElement>('input[name=raiseNum]');
  const btn = root.querySelector<HTMLButtonElement>('[data-action=raise]');
  if (range) range.value = String(amount);
  if (num && document.activeElement !== num) num.value = String(amount);
  if (btn) btn.innerHTML = `${raiseLabel(view, amount, legal)} <kbd>R</kbd>`;
}

function resultHtml(view: PublicView, seatName: (id: string) => string): string {
  const r = view.result;
  if (!r || view.stage !== 'finished') return '';
  const pots =
    r.pots.length > 1
      ? `<ul class="pots">${r.pots
          .map(
            (p, i) =>
              `<li>${i === 0 ? 'Основной банк' : `Побочный банк ${i}`} ${fmt(p.amount)} — ${p.winners
                .map((w) => esc(seatName(w)))
                .join(', ')}${p.handName ? ` (${esc(p.handName)})` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  return `<div class="result">${esc(r.summary)}${pots}</div>`;
}

export function tableHtml(ctx: TableCtx): string {
  const { view, session } = ctx;
  const n = view.seats.length;
  const youIdx = view.seats.findIndex((s) => s.isYou);
  const you = view.seats[youIdx];
  const r = view.result;

  // Победители основного банка и их лучшие 5 карт — подсвечиваем.
  const winners = new Set(r && view.stage === 'finished' ? r.pots.flatMap((p) => p.winners) : []);
  const highlight = new Set<Card>();
  if (r?.showdown) for (const id of r.pots[0]?.winners ?? []) (r.bestCards[id] ?? []).forEach((c) => highlight.add(c));

  const seatName = (id: string) => {
    const s = view.seats.find((x) => x.id === id);
    return s ? (s.isYou ? 'Вы' : s.name) : id;
  };

  const seats = view.seats.map((s, i) => seatHtml(s, (i - youIdx + n) % n, ctx, highlight, winners.has(s.id))).join('');

  const board = Array.from({ length: 5 }, (_, i) => {
    const c = view.board[i];
    if (!c) return '<div class="card md slot"></div>';
    const fresh = i >= ctx.boardFrom;
    return cardHtml(c, { size: 'md', hl: highlight.has(c), deal: fresh ? (i - ctx.boardFrom) * 220 : null });
  }).join('');

  const inHand = view.stage !== 'finished' && !you.folded;
  const leave = ctx.confirmLeave
    ? `<div class="leave-confirm">Карты будут сброшены, поставленное останется в банке.
         <button class="btn small danger" data-action="leave-yes">Встать</button>
         <button class="btn small ghost" data-action="leave-no">Остаться</button></div>`
    : `<button class="btn small ghost" data-action="leave" ${ctx.busy || ctx.closed ? 'disabled' : ''}
         data-confirm="${inHand ? '1' : ''}">Встать из-за стола</button>`;

  const st = session.stats;
  return `
  <section class="table-screen">
    <div class="table-col">
      <div class="table-bar">
        <div class="tb-info">
          <b>Раздача #${view.handNo}</b>
          <span>Блайнды ${view.smallBlind}/${view.bigBlind}</span>
          <span>Бай-ин ${fmt(session.buyIn)}</span>
          <span>Раздач ${st.handsPlayed} · в плюс ${st.handsWon}</span>
        </div>
        ${leave}
      </div>
      <div class="table-wrap">
        <div class="rail"><div class="felt">
          <div class="center">
            ${resultHtml(view, seatName) || `<div class="pot">Банк <b>${fmt(view.totalPot)}</b></div>`}
            <div class="board">${board}</div>
          </div>
          ${seats}
        </div></div>
      </div>
      <div class="controls">${controlsHtml(ctx)}</div>
    </div>
    <aside class="log-col">
      <h3>Ход раздачи</h3>
      <ol class="log">${view.log.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
    </aside>
  </section>`;
}
