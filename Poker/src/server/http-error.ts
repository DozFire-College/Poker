/** Ошибка, которую можно показать пользователю: сервер ответит этим статусом и текстом. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
