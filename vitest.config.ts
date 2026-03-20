import * as path from "node:path";
import { defineConfig } from "vitest/config";

const workspaceRoot = path.resolve(import.meta.dirname);
const webAppRoot = path.resolve(workspaceRoot, "apps", "web");
const isWebPackage = process.cwd() === webAppRoot;

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@t3tools\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "./packages/contracts/src/index.ts"),
      },
      {
        find: /^@t3tools\/shared$/,
        replacement: path.resolve(import.meta.dirname, "./packages/shared/src/index.ts"),
      },
      {
        find: /^~/,
        replacement: path.resolve(import.meta.dirname, "./apps/web/src/"),
      },
    ],
  },
  test: {
    environment: "jsdom",
  },
});
