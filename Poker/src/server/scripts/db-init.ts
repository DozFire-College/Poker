// Создаёт таблицы и добавляет покер в games.
//   npm run db:init            — схема + покер + демо-игрок demo
//   npm run db:init -- --no-demo — без демо-игрока
// Запускать можно сколько угодно раз: всё написано через IF NOT EXISTS / ON CONFLICT.
import '../env.js';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../db.js';

const files = ['01_schema.sql', '02_poker.sql'];
if (!process.argv.includes('--no-demo')) files.push('03_seed_demo.sql');

try {
  for (const file of files) {
    const sql = fs.readFileSync(path.resolve('db', file), 'utf8');
    await pool.query(sql);
    console.log(`✓ ${file}`);
  }
  const { rows } = await pool.query<{ id: number; balance: number }>(
    `SELECT id, balance FROM users WHERE username = 'demo'`,
  );
  if (rows[0]) {
    console.log(`Демо-игрок «demo»: id = ${rows[0].id}, баланс ${rows[0].balance}.`);
    if (rows[0].id !== 1) console.log(`Откройте игру с параметром ?user=${rows[0].id}`);
  }
} catch (e) {
  console.error('Не удалось подготовить базу:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
