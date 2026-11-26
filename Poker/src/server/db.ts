import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('Не задан DATABASE_URL. Скопируйте .env.example в .env и укажите подключение к PostgreSQL.');
  process.exit(1);
}

/** Пул подключений к PostgreSQL. Строка подключения — из DATABASE_URL. */
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Ошибка подключения к PostgreSQL:', err.message);
});
