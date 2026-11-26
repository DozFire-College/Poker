-- Демо-игрок для проверки покера без регистрации (только для разработки!).
-- Пароля у него нет: password_hash — заглушка, войти через обычный логин нельзя.
-- Начальный баланс записывается в журнал как signup_bonus, чтобы сумма транзакций
-- совпадала с балансом.
WITH new_user AS (
  INSERT INTO users (username, email, password_hash, balance, role)
  VALUES ('demo', 'demo@casino.local', 'dev-only-no-password', 10000, 'user')
  ON CONFLICT (username) DO NOTHING
  RETURNING id, balance
)
INSERT INTO transactions (user_id, bet_id, type, amount, balance_after)
SELECT id, NULL, 'signup_bonus', balance, balance FROM new_user;
