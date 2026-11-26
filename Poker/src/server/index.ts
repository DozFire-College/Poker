import './env.js'; // первым делом — переменные окружения из .env
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getUserId } from './auth.js';
import { HttpError } from './http-error.js';
import { MemoryPokerService } from './poker/memory-service.js';
import { createPokerRouter } from './poker/routes.js';
import { PokerService } from './poker/service.js';
import type { PokerBackend } from './poker/session.js';

// Демо-режим без базы: `npm run demo` (флаг --memory) или если DATABASE_URL не задан.
const memoryMode = process.argv.includes('--memory') || !process.env.DATABASE_URL;
if (memoryMode) {
  // В демо-режиме нет аккаунтов: игрок выбирается параметром ?user=ID в адресе страницы.
  process.env.DEV_AUTH = 'true';
}

// Модуль с подключением к PostgreSQL загружаем, только если база нужна.
const backend: PokerBackend = memoryMode
  ? new MemoryPokerService()
  : new PokerService((await import('./db.js')).pool);

const app = express();
app.use(express.json());

app.use('/api/poker', createPokerRouter(backend, getUserId));
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Такого адреса API нет' });
});

// После `npm run build` сервер сам отдаёт собранный клиент из dist/client.
// В разработке клиент отдаёт Vite (npm run dev), а /api проксируется сюда.
const clientDir = path.resolve('dist/client');
if (fs.existsSync(path.join(clientDir, 'index.html'))) {
  app.use(express.static(clientDir));
}

// Обработчик ошибок: понятные — пользователю, остальные — в консоль.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Некорректный JSON в запросе' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`API покера: http://localhost:${port}/api/poker`);
  if (memoryMode) {
    console.warn('ДЕМО-РЕЖИМ без базы данных: балансы и история хранятся в памяти и пропадут при перезапуске сервера.');
  } else if (process.env.DEV_AUTH === 'true') {
    console.warn('DEV_AUTH=true: игрок определяется по заголовку X-User-Id. Только для разработки!');
  }
});
