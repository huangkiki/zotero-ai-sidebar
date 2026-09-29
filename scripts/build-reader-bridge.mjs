import { build } from "esbuild";

await build({
  entryPoints: ["src/reader-bridge/index.ts"],
  bundle: true,
  format: "iife",
  globalName: "SidebarReaderBridge",
  target: "firefox115",
  outfile: ".scaffold/reader-bridge.js",
});
