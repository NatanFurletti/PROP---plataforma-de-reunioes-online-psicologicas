export class AppError extends Error {
  status: number;
  // Código estável para o frontend decidir o que mostrar (a mensagem pode mudar)
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}
