// Lint rules of the web app, plus a ban on host globals in the framework-neutral desktop core (SYNC-09, ADR-0069).
// Run from apps/web (`npm run lint`), which holds the eslint dependencies.
import base from "../../apps/web/eslint.config.js";

export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/testing/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["window", "document", "localStorage", "sessionStorage", "indexedDB", "navigator", "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval"].map(
          (name) => ({ name, message: "desktop-core is framework-neutral: use the platform port." }),
        ),
      ],
    },
  },
];
