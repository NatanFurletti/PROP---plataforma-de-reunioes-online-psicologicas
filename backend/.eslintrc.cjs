// Config do backend (Node + TypeScript). `.cjs` porque o package.json
// declara "type": "module" e o ESLint 8 carrega o config como CommonJS.
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  ignorePatterns: ["dist", "node_modules", "prisma/migrations"],
  rules: {
    // Argumentos iniciados por _ sao intencionalmente nao usados
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
  },
};
