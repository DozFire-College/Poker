-- Покер: запись в справочнике игр и две служебные таблицы.
--
-- Как движутся деньги:
--   сел за стол  → bets (amount = бай-ин) + transactions('bet', -бай-ин)
--   встал        → bets.payout = фишки со стола + transactions('win', +фишки)
--   проиграл всё → bets.payout = 0, сессия закрывается автоматически
-- Пока игрок за столом, его фишки хранятся в poker_sessions.state (стек на столе).

-- min_bet / max_bet для покера — минимальный и максимальный бай-ин.
-- Если у games.code есть CHECK со списком игр, добавьте туда 'poker'.
INSERT INTO games (code, name, min_bet, max_bet, is_active)
VALUES ('poker', 'Техасский холдем', 200, 2000, true)
ON CONFLICT (code) DO NOTHING;

-- Одна посадка за стол. Всё состояние стола (колода, карты, стеки ботов) — в state.
CREATE TABLE IF NOT EXISTS poker_sessions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id),
  bet_id     INTEGER     NOT NULL REFERENCES bets(id),
  status     VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  state      JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at  TIMESTAMPTZ
);
-- У игрока может быть только один открытый стол.
CREATE UNIQUE INDEX IF NOT EXISTS poker_sessions_one_active_idx
  ON poker_sessions (user_id) WHERE status = 'active';

-- История раздач (для экрана «Последние раздачи» и статистики).
CREATE TABLE IF NOT EXISTS poker_hands (
  id          SERIAL PRIMARY KEY,
  session_id  INTEGER     NOT NULL REFERENCES poker_sessions(id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(id),
  hand_no     INTEGER     NOT NULL,
  hole_cards  JSONB       NOT NULL,          -- карты игрока, например ["As","Kd"]
  board       JSONB       NOT NULL,          -- общие карты
  pot         INTEGER     NOT NULL,          -- весь банк раздачи
  invested    INTEGER     NOT NULL,          -- сколько поставил игрок
  won         INTEGER     NOT NULL,          -- сколько забрал из банка
  result_data JSONB       NOT NULL,          -- итог: победители, комбинации, открытые карты
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, hand_no)
);
CREATE INDEX IF NOT EXISTS poker_hands_user_idx ON poker_hands (user_id, id DESC);
