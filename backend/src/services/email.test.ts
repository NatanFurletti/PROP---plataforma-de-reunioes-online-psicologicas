import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET = "test-secret-do-not-use-in-prod";

const { ResendEmailDriver, BrevoEmailDriver, parseSender, renderActionEmail } =
  await import("./email");

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

describe("parseSender", () => {
  it("separa nome e endereço", () => {
    expect(parseSender("Palas <psipalascall@gmail.com>")).toEqual({
      name: "Palas",
      email: "psipalascall@gmail.com",
    });
    expect(parseSender('"Palas Call" <a@b.com>')).toEqual({
      name: "Palas Call",
      email: "a@b.com",
    });
  });

  it("aceita só o endereço", () => {
    expect(parseSender(" a@b.com ")).toEqual({ email: "a@b.com" });
    expect(parseSender("<a@b.com>")).toEqual({ email: "a@b.com" });
  });
});

describe("BrevoEmailDriver", () => {
  it("envia para a API do Brevo com chave, remetente e destinatário", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"messageId":"x"}', { status: 201 }));
    const driver = new BrevoEmailDriver(
      "xkeysib-test",
      "Palas <psipalascall@gmail.com>",
      fetchMock as unknown as typeof fetch,
    );

    await driver.send(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["api-key"]).toBe(
      "xkeysib-test",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { name: "Palas", email: "psipalascall@gmail.com" },
      to: [{ email: "ana@test.com" }],
      subject: message.subject,
      textContent: message.text,
    });
  });

  it("lança erro quando o Brevo recusa o envio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"code":"unauthorized","message":"sender not valid"}', {
        status: 400,
      }),
    );
    const driver = new BrevoEmailDriver(
      "xkeysib-test",
      "Palas <psipalascall@gmail.com>",
      fetchMock as unknown as typeof fetch,
    );

    await expect(driver.send(message)).rejects.toThrow(/400.*sender not valid/);
  });
});

describe("renderActionEmail", () => {
  it("gera botão e link clicáveis, escapando o conteúdo", () => {
    const html = renderActionEmail({
      intro: "Confirme <já>",
      buttonLabel: "Confirmar e-mail",
      link: "https://palas.test/verify-email/abc?x=1&y=2",
      footer: "Expira em 24 horas.",
    });

    expect(html).toContain(
      '<a href="https://palas.test/verify-email/abc?x=1&amp;y=2"',
    );
    expect(html).toContain(">Confirmar e-mail</a>");
    expect(html).toContain("Confirme &lt;já&gt;");
  });
});

describe("envio com HTML", () => {
  it("Brevo e Resend mandam a versão HTML junto do texto", async () => {
    const withHtml = { ...message, html: "<p>oi</p>" };
    const brevoFetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 201 }));
    const resendFetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await new BrevoEmailDriver(
      "k",
      "a@b.com",
      brevoFetch as unknown as typeof fetch,
    ).send(withHtml);
    await new ResendEmailDriver(
      "k",
      "a@b.com",
      resendFetch as unknown as typeof fetch,
    ).send(withHtml);

    const brevoBody = JSON.parse(
      (brevoFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    const resendBody = JSON.parse(
      (resendFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(brevoBody.htmlContent).toBe("<p>oi</p>");
    expect(brevoBody.textContent).toBe(message.text);
    expect(resendBody.html).toBe("<p>oi</p>");
    expect(resendBody.text).toBe(message.text);
  });
});
