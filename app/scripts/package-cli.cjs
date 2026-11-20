const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { copyTree, copyFile } = require("./package-copy.cjs");
const { createRuntimePackager } = require("./runtime-package.cjs");
const { SUPPORTED_TARGETS, resolveCliTarget, takeTargetArgument } = require("./cli-target.cjs");

function gitBuildMetadata(repoRoot) {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const sourceStatus = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repoRoot, encoding: "utf8" });
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    modifiedSource: sourceStatus.status === 0 ? Boolean(sourceStatus.stdout.trim()) : null,
    builtAt: new Date().toISOString(),
  };
}

function resolveCliOutputRoot(appRoot, outputRoot) {
  const configured = outputRoot ?? process.env.OCTOPUS_CLI_RUNTIME_DIR ?? null;
  if (configured !== null && configured !== "") return path.resolve(configured);
  return path.join(appRoot, "build", "cli", "runtime");
}

function packageCliRuntime({ appRoot = path.resolve(__dirname, ".."), target = null, outputRoot = null } = {}) {
  const cli = resolveCliTarget({ target });
  appRoot = fs.realpathSync(appRoot);
  const repoRoot = path.dirname(appRoot);
  const resolvedOutputRoot = resolveCliOutputRoot(appRoot, outputRoot);
  const outputParent = path.dirname(resolvedOutputRoot);
  fs.mkdirSync(outputParent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(outputParent, ".runtime-stage-"));
  let previous = null;
  try {
    if (cli.components.client_filesystem) {
      const clientFilesystem = require("../native/build.cjs").buildClientFilesystem();
      fs.mkdirSync(path.join(stage, "native", "build"), { recursive: true });
      copyFile(clientFilesystem, path.join(stage, "native", "build", path.basename(clientFilesystem)));
    }
    const packager = createRuntimePackager({ repoRoot, appRoot, outputRoot: stage });
    const source = path.join(repoRoot, "registry");
    const baseline = path.join(stage, "registry");
    const library = path.join(stage, "local-packages");
    const packages = path.join(library, "registry");
    const distribution = path.join(appRoot, "distribution");
    const binaries = packager.collectBundledBinaries(source);
    for (const binary of binaries) {
      const file = path.join(repoRoot, "target", "release", binary);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error(`Missing release executable: ${file}`);
    }
    packager.copyRegistryBaseline(source, baseline, path.join(distribution, "system-baseline.json"));
    packager.copyRegistrySurface(source, packages);
    packager.copyLocalPackageDefinitions(path.join(distribution, "local-packages"), library);
    require("esbuild").buildSync({
      entryPoints: [path.join(appRoot, "electron/clientDoctor.cjs")],
      outfile: path.join(stage, "client-doctor.cjs"),
      bundle: true, platform: "node", target: "node24", format: "cjs",
    });
    copyTree(path.join(repoRoot, "schemas"), path.join(stage, "schemas"), { recursive: true });
    copyTree(distribution, path.join(stage, "distribution"), { recursive: true });
    const ownership = packager.registryExecutableOwnership(packages);
    const ownerExecutables = new Set();
    const installationReferences = new Set();
    packager.rewriteBundledExecutablePaths(packages, ownership, ownerExecutables, installationReferences);
    packager.rewriteBundledExecutablePaths(baseline, ownership, ownerExecutables, installationReferences);
    const installationBinaries = packager.sharedBinaries(installationReferences);
    const sharedExecutables = packager.copyBundledBinaries(installationBinaries);
    packager.stripExecutables([...ownerExecutables, ...sharedExecutables]);
    const managed = require(path.join(source, "interface/world_provider_codex/packages/octopus-provider-codex/managed-cli/bootstrap.cjs"));
    const managedRoots = cli.components.managed_codex ? packager.bundleManagedCodex([baseline, packages]) : [];
    const providerSigning = packager.captureProviderSigningInputs([baseline, packages]);
    if (cli.components.code_signing) {
      const managedSigning = managed.captureSigning(managedRoots);
      packager.signClientResources(stage);
      managed.sealSigning(managedSigning);
      packager.sealProviderSigningInputs(providerSigning);
    }
    packager.validateBundledLayout([baseline, packages], installationBinaries, ownerExecutables);
    const git = gitBuildMetadata(repoRoot);
    const receipt = {
      schema: "octopus.cli_runtime_distribution", schema_version: 1,
      package_version: JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version,
      revision: git.revision, modifiedSource: git.modifiedSource, builtAt: git.builtAt,
      platform: cli.platform, architecture: cli.architecture, target: cli.triple, components: cli.components,
      binaries: installationBinaries.map((binary) => {
        const bytes = fs.readFileSync(path.join(stage, "bin", binary));
        return { path: `bin/${binary}`, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
      }),
    };
    fs.writeFileSync(path.join(stage, "runtime-build-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (fs.existsSync(resolvedOutputRoot)) {
      if (!fs.lstatSync(resolvedOutputRoot).isDirectory()) throw new Error(`Runtime output is not a plain directory: ${resolvedOutputRoot}`);
      previous = fs.mkdtempSync(path.join(outputParent, ".runtime-previous-"));
      fs.rmdirSync(previous);
      fs.renameSync(resolvedOutputRoot, previous);
    }
    try { fs.renameSync(stage, resolvedOutputRoot); }
    catch (error) { if (previous) fs.renameSync(previous, resolvedOutputRoot); previous = null; throw error; }
    if (previous) fs.rmSync(previous, { recursive: true });
    return { outputRoot: resolvedOutputRoot, target: cli.triple, binaryCount: installationBinaries.length, ownerExecutableCount: ownerExecutables.size };
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
  }
}

function takeOutputArgument(argv) {
  let outputRoot = null;
  const rest = [];
  for (const argument of argv) {
    if (!argument.startsWith("--output")) { rest.push(argument); continue; }
    const value = argument.startsWith("--output=") ? argument.slice("--output=".length) : "";
    if (!value) throw new Error("--output requires a value, as --output=<directory>");
    if (outputRoot !== null) throw new Error("--output is given more than once");
    outputRoot = path.resolve(value);
  }
  return { outputRoot, rest };
}

if (require.main === module) {
  try {
    const targetParsed = takeTargetArgument(process.argv.slice(2));
    const { outputRoot, rest } = takeOutputArgument(targetParsed.rest);
    if (rest.length) throw new Error(`Usage: node app/scripts/package-cli.cjs [--target=<${SUPPORTED_TARGETS.join("|")}>] [--output=<directory>] (consumes target/release binaries)`);
    console.log(JSON.stringify(packageCliRuntime({ target: targetParsed.target, outputRoot })));
    require("./build-space-notice.cjs").printBuildSpaceNotice();
  } catch (error) {
    console.error(`CLI runtime packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { packageCliRuntime, resolveCliOutputRoot, takeOutputArgument };
