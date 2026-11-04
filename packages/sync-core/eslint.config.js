// Lint rules of the web app, plus a ban on host globals in the framework-free core (SYNC-08).
// Run from apps/web (`npm run lint`), which holds the eslint dependencies.
import base from "../../apps/web/eslint.config.js";

export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["window", "document", "localStorage", "sessionStorage", "indexedDB", "navigator", "fetch", "setTimeout", "setInterval"].map(
          (name) => ({ name, message: "sync-core is framework-free: inject it through a port." }),
        ),
      ],
    },
  },
];
