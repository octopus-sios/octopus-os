const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { releaseLinux, inspectBundle, sha256File } = require("./release-linux.cjs");

function createFakeLinuxBundle(root, { version = "0.1.0", architecture = "x64", platform = "linux", corruptBinary = false } = {}) {
  const bundle = path.join(root, "runtime");
  const binDir = path.join(bundle, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(bundle, "registry"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "local-packages", "registry"), { recursive: true });
  const octopus = path.join(binDir, "octopus");
  fs.writeFileSync(octopus, "#!/bin/sh\necho octopus\n", { mode: 0o755 });
  const bytes = fs.readFileSync(octopus);
  const sha256 = corruptBinary ? "f".repeat(64) : crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(bundle, "registry", ".octopus-source.json"), JSON.stringify({ schema_version: 1, id: "test" }) + "\n");
  fs.writeFileSync(path.join(bundle, "local-packages", "registry", ".octopus-source.json"), JSON.stringify({ schema_version: 1, id: "test" }) + "\n");
  fs.writeFileSync(path.join(bundle, "client-doctor.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(bundle, "runtime-build-receipt.json"), JSON.stringify({
    schema: "octopus.cli_runtime_distribution",
    schema_version: 1,
    package_version: version,
    revision: "a".repeat(40),
    modifiedSource: false,
    builtAt: "2026-11-20T00:00:00.000Z",
    platform,
    architecture,
    target: architecture === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu",
    components: { client_filesystem: false, desktop_native: false, managed_codex: true, code_signing: false },
    binaries: [{ path: "bin/octopus", bytes: bytes.length, sha256 }],
  }, null, 2) + "\n");
  return bundle;
}

test("releaseLinux packages, verifies, and writes SHA-256 checksum for a Linux CLI bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-release-linux-test-"));
  try {
    const bundle = createFakeLinuxBundle(root);
    const output = path.join(root, "release-linux");
    let verifiedBinDir = null;
    const result = releaseLinux({
      bundle,
      output,
      version: "0.1.0",
      verifyManagedCodex: (binDir) => { verifiedBinDir = binDir; },
    });
    assert.equal(verifiedBinDir, path.join(bundle, "bin"));
    assert.equal(path.basename(result.archive), "Octopus-0.1.0-linux-x64.tar.gz");
    assert.equal(path.basename(result.shaFile), "Octopus-0.1.0-linux-x64.tar.gz.sha256");
    assert.equal(result.sha256, sha256File(result.archive));
    assert.equal(
      fs.readFileSync(result.shaFile, "utf8"),
      `${result.sha256}  Octopus-0.1.0-linux-x64.tar.gz\n`,
    );
    const extracted = path.join(root, "extracted");
    fs.mkdirSync(extracted, { recursive: true });
    const untar = spawnSync("tar", ["-xzf", result.archive, "-C", extracted], { encoding: "utf8" });
    assert.equal(untar.status, 0);
    assert.equal(fs.existsSync(path.join(extracted, "octopus-0.1.0-linux-x64", "bin", "octopus")), true);
    assert.equal(
      fs.existsSync(path.join(extracted, "octopus-0.1.0-linux-x64", "packaging", "linux", "octopus-runtime.service")),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspectBundle fails closed on non-Linux platform, version mismatch, or corrupted binary hash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-release-linux-err-"));
  try {
    const macBundle = createFakeLinuxBundle(path.join(root, "mac"), { platform: "darwin" });
    assert.throws(() => inspectBundle(macBundle, "0.1.0", { verifyManagedCodex: () => {} }), /expected Linux CLI bundle/);

    const badVer = createFakeLinuxBundle(path.join(root, "ver"), { version: "0.2.0" });
    assert.throws(() => inspectBundle(badVer, "0.1.0", { verifyManagedCodex: () => {} }), /does not match package\.json/);

    const corrupt = createFakeLinuxBundle(path.join(root, "corrupt"), { corruptBinary: true });
    assert.throws(() => inspectBundle(corrupt, "0.1.0", { verifyManagedCodex: () => {} }), /SHA-256 mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
