import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublicView, TableResponse } from '../src/shared/poker-types.js';
import { HttpError } from '../src/server/http-error.js';
import { MEMORY_START_BALANCE, MemoryPokerService } from '../src/server/poker/memory-service.js';

async function rejects(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (e: unknown) => e instanceof HttpError && e.status === status);
}

/** Никакой кадр не должен раскрывать колоду или карты ботов до вскрытия. */
function checkHidden(resp: TableResponse) {
  const views: PublicView[] = [...resp.frames, ...(resp.session ? [resp.session.view] : [])];
  for (const v of views) {
    assert.equal(JSON.stringify(v).includes('deck'), false);
    const showdown = v.stage === 'finished' && v.result?.showdown;
    for (const s of v.seats) if (!s.isYou && !showdown) assert.ok(s.cards.every((c) => c === null));
  }
}

test('демо-режим: посадка, игра, выход — деньги сходятся', async () => {
  const svc = new MemoryPokerService();
  const cfg = await svc.getConfig(1);
  assert.equal(cfg.username, 'demo');
  assert.equal(cfg.balance, MEMORY_START_BALANCE);
  assert.equal(cfg.demoMode, true);

  await rejects(svc.sit(1, 100, 3), 400);
  await rejects(svc.sit(1, 1000, 0), 400);
  await rejects(svc.act(1, { type: 'call' }), 404);

  let resp = await svc.sit(1, 1000, 3);
  checkHidden(resp);
  assert.equal(resp.balance, MEMORY_START_BALANCE - 1000);
  await rejects(svc.sit(1, 1000, 3), 409);

  // Играем раздачи чек/коллом, пока не наберётся 10 или не кончатся фишки.
  let hands = 0;
  while (hands < 10 && resp.session && !resp.closed) {
    const v = resp.session.view;
    if (v.stage === 'finished') {
      hands++;
      await rejects(svc.act(1, { type: 'check' }), 400); // не наш ход
      resp = await svc.nextHand(1);
    } else {
      assert.ok(v.legal);
      await rejects(svc.act(1, { type: 'raise', amount: v.legal.minRaiseTo - 1 }), 400);
      resp = await svc.act(1, { type: v.legal.canCheck ? 'check' : 'call' });
    }
    checkHidden(resp);
  }

  const history = await svc.history(1, 50);
  assert.ok(history.length >= hands);

  if (resp.closed) {
    assert.equal(resp.closed.reason, 'bust');
    assert.equal(resp.balance, MEMORY_START_BALANCE - 1000);
  } else {
    const stack = resp.session!.view.seats[0].stack;
    const midHand = resp.session!.view.stage !== 'finished';
    const left = await svc.leave(1);
    assert.equal(left.session, null);
    // Выход посреди раздачи: поставленное в банк пропадает, стек возвращается целиком.
    assert.equal(left.closed!.cashOut, stack);
    assert.equal(left.balance, MEMORY_START_BALANCE - 1000 + stack);
    assert.equal(left.closed!.profit, stack - 1000);
    console.log(`  сыграно ${hands} раздач, вышли ${midHand ? 'посреди раздачи' : 'между раздачами'} с ${stack}`);
  }
  assert.equal((await svc.getState(1)).session, null);
  await rejects(svc.leave(1), 404);
});

test('демо-режим: проигрыш всех фишек закрывает стол', async () => {
  const svc = new MemoryPokerService();
  let resp = await svc.sit(7, 200, 5);
  assert.equal((await svc.getConfig(7)).username, 'игрок7');
  for (let i = 0; i < 400 && !resp.closed; i++) {
    resp = resp.session!.view.stage === 'finished' ? await svc.nextHand(7) : await svc.act(7, { type: 'allin' });
  }
  if (!resp.closed) return; // очень маловероятно: игрок выигрывал всё время
  assert.equal(resp.closed.reason, 'bust');
  assert.equal(resp.closed.cashOut, 0);
  assert.equal(resp.balance, MEMORY_START_BALANCE - 200);
  await rejects(svc.nextHand(7), 404);
  // Можно сесть снова.
  const again = await svc.sit(7, 200, 1);
  assert.ok(again.session);
});

test('демо-режим: ошибка хода не портит состояние стола', async () => {
  const svc = new MemoryPokerService();
  const resp = await svc.sit(2, 500, 2);
  const before = JSON.stringify((await svc.getState(2)).session);
  await rejects(svc.act(2, { type: 'raise', amount: 1 }), 400);
  await rejects(svc.act(2, { type: 'dance' as never }), 400);
  if (resp.session!.view.stage !== 'finished') await rejects(svc.nextHand(2), 409);
  assert.equal(JSON.stringify((await svc.getState(2)).session), before);
});
