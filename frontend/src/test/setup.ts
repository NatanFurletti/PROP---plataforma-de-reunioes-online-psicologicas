import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Desmonta a árvore React entre os testes para evitar vazamento de estado
afterEach(() => {
  cleanup();
});
