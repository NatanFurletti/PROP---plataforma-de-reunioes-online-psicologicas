import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ControlButton } from "./ControlButton";

describe("ControlButton", () => {
  it("renderiza o conteúdo e dispara onClick", async () => {
    const onClick = vi.fn();
    render(<ControlButton onClick={onClick}>Encerrar</ControlButton>);

    const button = screen.getByRole("button", { name: "Encerrar" });
    await userEvent.click(button);

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("não dispara onClick quando desabilitado", async () => {
    const onClick = vi.fn();
    render(
      <ControlButton onClick={onClick} disabled>
        Encerrar
      </ControlButton>,
    );

    const button = screen.getByRole("button", { name: "Encerrar" });
    expect(button).toBeDisabled();

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
