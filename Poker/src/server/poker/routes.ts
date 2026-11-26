import { Router, type Request } from 'express';
import type { PlayerAction } from '../../shared/poker-types.js';
import type { PokerBackend } from './session.js';

/**
 * Роуты покера. Подключаются в приложении так:
 *   app.use('/api/poker', createPokerRouter(new PokerService(pool), getUserId));
 * getUserId берёт id игрока из вашей авторизации (сессия, JWT).
 *
 * Express 5 сам передаёт ошибки из async-обработчиков в обработчик ошибок.
 */
export function createPokerRouter(service: PokerBackend, getUserId: (req: Request) => number): Router {
  const router = Router();

  // Настройки стола и баланс игрока — для лобби.
  router.get('/config', async (req, res) => {
    res.json(await service.getConfig(getUserId(req)));
  });

  // Текущий стол (если игрок за ним сидит) — например, после перезагрузки страницы.
  router.get('/state', async (req, res) => {
    res.json(await service.getState(getUserId(req)));
  });

  // Сесть за стол: { buyIn: 1000, bots: 3 }
  router.post('/sit', async (req, res) => {
    const { buyIn, bots } = req.body ?? {};
    res.json(await service.sit(getUserId(req), Number(buyIn), Number(bots)));
  });

  // Ход игрока: { type: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: number }
  router.post('/action', async (req, res) => {
    const body = (req.body ?? {}) as Partial<PlayerAction>;
    res.json(await service.act(getUserId(req), { type: body.type!, amount: body.amount }));
  });

  router.post('/next-hand', async (req, res) => {
    res.json(await service.nextHand(getUserId(req)));
  });

  router.post('/leave', async (req, res) => {
    res.json(await service.leave(getUserId(req)));
  });

  // Последние раздачи игрока: ?limit=20
  router.get('/history', async (req, res) => {
    res.json(await service.history(getUserId(req), Number(req.query.limit ?? 20)));
  });

  return router;
}
