import { defineConfig } from "zotero-plugin-scaffold";
import { readFile, unlink, writeFile } from "node:fs/promises";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    hooks: {
      "build:bundle": async (ctx) => {
        const manifestPath = `${ctx.dist}/addon/manifest.json`;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        // The scaffold injects update_url by default; this project ships XPI-only releases.
        delete manifest.applications?.zotero?.update_url;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
      "build:makeUpdateJSON": async (ctx) => {
        await Promise.allSettled([
          unlink(`${ctx.dist}/update.json`),
          unlink(`${ctx.dist}/update-beta.json`),
        ]);
      },
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
          "process.env.NODE_ENV": '"production"',
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
