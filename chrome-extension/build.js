import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const commonOptions = {
  bundle: true,
  sourcemap: true,
  target: "chrome120",
  format: "esm",
  outdir: "dist",
};

async function build() {
  if (watch) {
    const bgCtx = await esbuild.context({
      ...commonOptions,
      entryPoints: ["src/background.ts"],
    });
    await bgCtx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build({
      ...commonOptions,
      entryPoints: ["src/background.ts"],
    });
    console.log("Build complete");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
