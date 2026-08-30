import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [".husky/_", "coverage", "node_modules"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{cjs,mjs,js}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.bun,
        ...globals.node,
      },
      parserOptions: {},
      sourceType: "module",
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      "@typescript-eslint/no-use-before-define": [
        "warn",
        {
          classes: true,
          enums: true,
          functions: true,
          ignoreTypeReferences: false,
          typedefs: true,
          variables: true,
        },
      ],
      "import/exports-last": "warn",
      "import/group-exports": "warn",
      "no-useless-escape": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  eslintConfigPrettier,
]);
