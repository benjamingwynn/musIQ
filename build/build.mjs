import * as esbuild from "esbuild"
import fs from "node:fs/promises"
import path from "node:path"

/**
 * Inline-worker loader: `import createWorker from "./thing.worker.ts?inline-worker"`.
 * The worker is separately bundled (including WASM-loader glue such as aubiojs), then
 * embedded as source in the single output module. No eval/RPC export surgery required.
 */
const inlineWorkerPlugin = {
  name: "inline-worker",
  setup(build) {
    build.onResolve({filter: /\?inline-worker$/}, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?inline-worker$/, "")),
      namespace: "inline-worker",
    }))

    build.onLoad({filter: /.*/, namespace: "inline-worker"}, async (args) => {
      const result = await esbuild.build({
        entryPoints: [args.path],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify: true,
        legalComments: "none",
        alias: {aubiojs: path.resolve("node_modules/aubiojs/build/aubio.esm.js")},
        define: {"import.meta.url": "self.location.href", "globalThis._isNodeJs": "false", require: "undefined"},
      })
      const source = result.outputFiles[0]?.text
      if (!source) throw new Error(`worker build produced no output for ${args.path}`)
      return {
        loader: "js",
        contents: `
          const source = ${JSON.stringify(source)};
          export default function createWorker() {
            const url = URL.createObjectURL(new Blob([source], {type: "text/javascript"}));
            const worker = new Worker(url);
            const revoke = () => URL.revokeObjectURL(url);
            worker.addEventListener("error", revoke, {once: true});
            const terminate = worker.terminate.bind(worker);
            worker.terminate = () => { revoke(); terminate(); };
            return worker;
          }
        `,
      }
    })
  },
}

await fs.mkdir("dist", {recursive: true})
await fs.copyFile("musiq.d.ts", "dist/musiq.d.ts")
await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/musiq.mjs",
  sourcemap: true,
  minify: true,
  legalComments: "none",
  plugins: [inlineWorkerPlugin],
})

// TypeScript owns the public declaration file; esbuild only owns runtime bundling.
await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: ".build-check",
  logLevel: "silent",
})
console.log("built dist/musiq.mjs")
