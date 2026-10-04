import tseslint from "typescript-eslint";

/**
 * The lint gate (`npm run lint`), type-aware: rules see TypeScript's own
 * type information, so it catches what `tsc --noEmit` does not — floating
 * promises, unsafe `any` propagation, needless awaits.
 *
 * Typescript-ESLint's peer range does not yet declare TypeScript 7, so this
 * project installs it with `--legacy-peer-deps`; the parser works against the
 * installed compiler (verified in CI on every push).
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "eslint.config.mjs"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Both projects: the build config covers src/, the test config adds
        // the suites and testHelpers — the project service's default lookup
        // only opens tsconfig.json, which deliberately excludes them.
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // `describe()`/`it()` hand their promise to the node:test runner, which
    // owns the rejection — awaiting them at module scope would be impossible
    // and would serialise every test. Every other floating promise stays an
    // error, inside test bodies included.
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: ["describe", "it"] },
      ],
    },
  },
  {
    // Test payloads are parsed JSON: `any` is the honest type of "whatever
    // the tool returned", and the helpers deliberately hand it back
    // untyped so each assertion reads as data, not as cast ceremony.
    files: ["**/*.test.ts", "src/testHelpers.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  }
);
