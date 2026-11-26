-- Основная схема казино (по вашей ER-диаграмме).
-- Если эти таблицы в проекте уже есть — файл ничего не сломает (IF NOT EXISTS),
-- но и не изменит существующие таблицы.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT         NOT NULL,              -- только хеш, сам пароль не храним
  balance       INTEGER      NOT NULL DEFAULT 0 CHECK (balance >= 0),
  role          VARCHAR(10)  NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS games (
  id        SERIAL PRIMARY KEY,
  code      VARCHAR(30)  NOT NULL UNIQUE,            -- slots, roulette, blackjack, dice, poker
  name      VARCHAR(100) NOT NULL,
  min_bet   INTEGER      NOT NULL CHECK (min_bet > 0),
  max_bet   INTEGER      NOT NULL CHECK (max_bet >= min_bet),
  is_active BOOLEAN      NOT NULL DEFAULT true       -- админ может выключить игру
);

CREATE TABLE IF NOT EXISTS bets (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id),
  game_id     INTEGER     NOT NULL REFERENCES games(id),
  amount      INTEGER     NOT NULL CHECK (amount > 0),        -- ставка
  payout      INTEGER     NOT NULL DEFAULT 0 CHECK (payout >= 0), -- выигрыш, 0 при проигрыше
  bet_data    JSONB       NOT NULL DEFAULT '{}',              -- на что ставили
  result_data JSONB       NOT NULL DEFAULT '{}',              -- что выпало
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bets_user_created_idx ON bets (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transactions (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER     NOT NULL REFERENCES users(id),
  bet_id        INTEGER     REFERENCES bets(id),              -- может быть пустым (бонусы, правки админа)
  type          VARCHAR(20) NOT NULL
                CHECK (type IN ('bet', 'win', 'bonus', 'signup_bonus', 'admin_adjust')),
  amount        INTEGER     NOT NULL,                         -- с минусом при списании
  balance_after INTEGER     NOT NULL CHECK (balance_after >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_user_created_idx ON transactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bonuses (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id),
  amount     INTEGER     NOT NULL CHECK (amount > 0),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
