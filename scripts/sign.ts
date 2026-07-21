/**
 * Ad-hoc sign a `bun build --compile` binary for macOS.
 *
 * An unsigned Bun executable is killed by the kernel on arm64 macOS (SIGKILL,
 * exit 137) with no error message, so a locally built `dist/dosya` looks
 * broken until it is signed. The release workflow signs with ldid; this makes
 * `bun run build` produce a runnable binary too.
 *
 * Usage: bun run scripts/sign.ts <path-to-binary>
 */

const target = process.argv[2];

if (!target) {
    console.error("usage: bun run scripts/sign.ts <binary>");
    process.exit(2);
}

if (process.platform !== "darwin") {
    // Only macOS requires this
    process.exit(0);
}

if (!(await Bun.file(target).exists())) {
    console.error(`sign: ${target} not found`);
    process.exit(1);
}

// `codesign` rejects Bun's compiled output ("invalid or unsupported format"),
// so ldid is the tool that works here.
const result = Bun.spawnSync(["ldid", "-S", target], { stderr: "pipe" });

if (result.exitCode === 0) {
    console.log(`signed ${target}`);
    process.exit(0);
}

const stderr = result.stderr.toString().trim();
console.warn(
    `warning: could not sign ${target}${stderr ? ` (${stderr})` : ""}.\n` +
    `  Install ldid to fix: brew install ldid\n` +
    `  Without a signature macOS kills the binary with exit code 137.`,
);
// A missing signer shouldn't fail the build on non-release machines
process.exit(0);
