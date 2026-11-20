const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { copyTree, copyFile } = require("./package-copy.cjs");

const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.dirname(appRoot);
const managedCodex = require(path.join(repoRoot, "registry", "interface", "world_provider_codex", "packages", "octopus-provider-codex", "managed-cli", "bootstrap.cjs"));
const expectedTargets = {
  x64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu",
};

function defaultPackagingFiles() {
  const processAuthorityRoot = path.join(
    repoRoot, "registry", "worker_environment_kind", "process_session",
    "packages", "octopus-linux-process-authority",
  );
  return [
    { source: path.join(repoRoot, "packaging", "linux", "octopus-runtime.service"), destination: "packaging/linux/octopus-runtime.service" },
    { source: path.join(processAuthorityRoot, "octopus-process-authority.service"), destination: "packaging/linux/octopus-process-authority.service" },
    { source: path.join(processAuthorityRoot, "install-linux.sh"), destination: "packaging/linux/install-linux.sh", mode: 0o755 },
  ];
}

function releaseLinux(options = {}) {
  const bundle = path.resolve(options.bundle ?? path.join(appRoot, "build", "cli", "runtime"));
  const output = path.resolve(options.output ?? path.join(appRoot, "build", "release-linux"));
  const version = options.version ?? JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
  const verifyManagedCodex = options.verifyManagedCodex ?? ((binDir) => managedCodex.verifyInstallation(binDir));
  const packagingFiles = options.packagingFiles === undefined
    ? (options.serviceTemplate === undefined
      ? defaultPackagingFiles()
      : (options.serviceTemplate
        ? [{ source: options.serviceTemplate, destination: `packaging/linux/${path.basename(options.serviceTemplate)}` }]
        : []))
    : options.packagingFiles;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package version must be a three-part numeric version: ${version}`);
  if (output === bundle || output.startsWith(`${bundle}${path.sep}`)) throw new Error("release output must be outside the bundle");
  const { architecture, target } = inspectBundle(bundle, version, { verifyManagedCodex });
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const rootName = `octopus-${version}-linux-${architecture}`;
  const archiveName = `Octopus-${version}-linux-${architecture}.tar.gz`;
  const archive = writeTarball({ bundle, output, archiveName, rootName, packagingFiles });
  const digest = sha256File(archive);
  const shaFile = path.join(output, `${archiveName}.sha256`);
  fs.writeFileSync(shaFile, `${digest}  ${archiveName}\n`);
  return {
    version,
    architecture,
    target,
    archive,
    shaFile,
    sha256: digest,
    bytes: fs.statSync(archive).size,
  };
}

function parseArguments(argv) {
  const options = {
    bundle: path.join(appRoot, "build", "cli", "runtime"),
    output: path.join(appRoot, "build", "release-linux"),
  };
  for (const argument of argv) {
    const [key, value] = argument.split(/=(.*)/s, 2);
    if (key === "--bundle" && value) options.bundle = path.resolve(value);
    else if (key === "--output" && value) options.output = path.resolve(value);
    else throw new Error("Usage: release-linux.cjs [--bundle=<runtime-dir>] [--output=<directory>]");
  }
  return options;
}

function inspectBundle(bundle, version, { verifyManagedCodex = (binDir) => managedCodex.verifyInstallation(binDir) } = {}) {
  if (!fs.statSync(bundle, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Linux CLI bundle directory is missing: ${bundle}`);
  }
  const receiptPath = path.join(bundle, "runtime-build-receipt.json");
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")); }
  catch (error) { throw new Error(`Linux CLI bundle is missing a valid runtime-build-receipt.json: ${error.message}`); }
  if (receipt.schema !== "octopus.cli_runtime_distribution" || receipt.schema_version !== 1) {
    throw new Error(`unexpected CLI receipt schema: ${receipt.schema}@${receipt.schema_version}`);
  }
  if (receipt.platform !== "linux") {
    throw new Error(`expected Linux CLI bundle, got platform '${receipt.platform}'`);
  }
  const architecture = receipt.architecture;
  if (!Object.hasOwn(expectedTargets, architecture)) {
    throw new Error(`unsupported Linux architecture '${architecture}'`);
  }
  if (receipt.target !== expectedTargets[architecture]) {
    throw new Error(`receipt target '${receipt.target}' does not match expected '${expectedTargets[architecture]}'`);
  }
  if (receipt.package_version !== version) {
    throw new Error(`receipt package_version '${receipt.package_version}' does not match package.json '${version}'`);
  }
  const binDir = path.join(bundle, "bin");
  const runtimeBin = path.join(binDir, "octopus");
  const runtimeStat = fs.lstatSync(runtimeBin, { throwIfNoEntry: false });
  if (!runtimeStat?.isFile() || !(runtimeStat.mode & 0o111)) {
    throw new Error("Linux CLI bundle has no executable bin/octopus binary");
  }
  const authorityBin = path.join(binDir, "octopus-linux-process-authority");
  const authorityStat = fs.lstatSync(authorityBin, { throwIfNoEntry: false });
  if (!authorityStat?.isFile() || !(authorityStat.mode & 0o111)) {
    throw new Error("Linux CLI bundle has no executable bin/octopus-linux-process-authority binary");
  }
  if (receipt.components?.process_authority !== true) {
    throw new Error("Linux CLI receipt must declare components.process_authority=true");
  }
  if (!Array.isArray(receipt.binaries) || receipt.binaries.length === 0) {
    throw new Error("Linux CLI receipt declares no binaries");
  }
  const attestedPaths = new Set();
  for (const entry of receipt.binaries) {
    if (typeof entry?.path !== "string" || !Number.isSafeInteger(entry?.bytes) || !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? "")) {
      throw new Error(`malformed binary receipt entry: ${JSON.stringify(entry)}`);
    }
    attestedPaths.add(entry.path);
    const file = path.resolve(bundle, entry.path);
    const relative = path.relative(bundle, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`binary receipt path escapes bundle: ${entry.path}`);
    }
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`missing receipt binary: ${entry.path}`);
    if (stat.size !== entry.bytes) throw new Error(`receipt binary size mismatch for ${entry.path}`);
    if (sha256File(file) !== entry.sha256) throw new Error(`receipt binary SHA-256 mismatch for ${entry.path}`);
  }
  for (const requiredBin of ["bin/octopus", "bin/octopus-linux-process-authority"]) {
    if (!attestedPaths.has(requiredBin)) {
      throw new Error(`Linux CLI receipt does not attest required binary: ${requiredBin}`);
    }
  }
  for (const required of [
    path.join("registry", ".octopus-source.json"),
    path.join("local-packages", "registry", ".octopus-source.json"),
    "client-doctor.cjs",
  ]) {
    if (!fs.existsSync(path.join(bundle, required))) {
      throw new Error(`Linux CLI bundle is missing required file: ${required}`);
    }
  }
  if (receipt.components?.managed_codex) {
    verifyManagedCodex(binDir);
  }
  return { architecture, target: receipt.target, receipt };
}

function writeTarball({ bundle, output, archiveName, rootName, packagingFiles }) {
  const archive = path.join(output, archiveName);
  const stage = fs.mkdtempSync(path.join(output, ".tarball-stage-"));
  const verify = fs.mkdtempSync(path.join(output, ".tarball-verify-"));
  try {
    const stagedRoot = path.join(stage, rootName);
    copyTree(bundle, stagedRoot, { recursive: true, verbatimSymlinks: true }, "linux");
    for (const file of packagingFiles) {
      if (!file?.source || !fs.existsSync(file.source)) {
        throw new Error(`Required Linux packaging file is missing: ${file?.source ?? "<unspecified>"}`);
      }
      const destination = path.join(stagedRoot, ...file.destination.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      copyFile(file.source, destination, "linux");
      if (file.mode !== undefined) fs.chmodSync(destination, file.mode);
    }
    const expected = treeManifest(stagedRoot);
    run("tar", ["-czf", archive, "-C", stage, rootName]);
    run("tar", ["-xzf", archive, "-C", verify]);
    compareTrees(expected, treeManifest(path.join(verify, rootName)), archiveName);
    return archive;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(verify, { recursive: true, force: true });
  }
}

function treeManifest(root) {
  const manifest = new Map();
  const parent = path.dirname(root);
  const visit = (file) => {
    const stat = fs.lstatSync(file);
    const relative = path.relative(parent, file).split(path.sep).join("/");
    let entry;
    if (stat.isSymbolicLink()) entry = { type: "symlink", target: fs.readlinkSync(file) };
    else if (stat.isDirectory()) entry = { type: "directory", mode: stat.mode & 0o777 };
    else if (stat.isFile()) entry = { type: "file", mode: stat.mode & 0o777, size: stat.size, sha256: sha256File(file) };
    else throw new Error(`release bundle contains an unsupported entry: ${file}`);
    manifest.set(relative, JSON.stringify(entry));
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  };
  visit(root);
  return manifest;
}

function compareTrees(expected, actual, label) {
  const differences = [];
  for (const [file, entry] of expected) if (actual.get(file) !== entry) differences.push(file);
  for (const file of actual.keys()) if (!expected.has(file)) differences.push(file);
  if (differences.length) {
    throw new Error(`${label} differs from the staged bundle at ${differences.length} path(s), first: ${differences.slice(0, 5).join(", ")}`);
  }
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? result.signal}`);
}

if (require.main === module) {
  try {
    const result = releaseLinux(parseArguments(process.argv.slice(2)));
    console.log(`${path.basename(result.archive)}\t${result.bytes}\t${result.sha256}`);
    console.log(`Linux CLI release assets for ${result.version} (${result.target}) are in ${path.dirname(result.archive)}`);
  } catch (error) {
    console.error(`Linux release failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { releaseLinux, inspectBundle, parseArguments, sha256File };
