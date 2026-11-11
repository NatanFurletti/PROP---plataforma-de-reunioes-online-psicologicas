import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET = "test-secret-do-not-use-in-prod";

const { ResendEmailDriver } = await import("./email");

const message = {
  to: "ana@test.com",
  subject: "Confirme seu e-mail — Palas",
  text: "Para confirmar seu e-mail, acesse: http://x/verify-email/abc",
};

describe("ResendEmailDriver", () => {
  it("envia para a API do Resend com chave, remetente e destinatário", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const driver = new ResendEmailDriver(
      "re_test",
      "Palas <nao-responda@palas.test>",
      fetchMock as unknown as typeof fetch,
    );

    await driver.send(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Palas <nao-responda@palas.test>",
      to: ["ana@test.com"],
      subject: message.subject,
      text: message.text,
    });
  });

  it("lança erro quando o Resend recusa o envio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"message":"domain is not verified"}', { status: 403 }),
    );
    const driver = new ResendEmailDriver(
      "re_test",
      "Palas <nao-responda@palas.test>",
      fetchMock as unknown as typeof fetch,
    );

    await expect(driver.send(message)).rejects.toThrow(
      /403.*domain is not verified/,
    );
  });
});
