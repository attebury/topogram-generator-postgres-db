import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(root, ".tmp", "generator-check");
const npmCache = path.join(workRoot, "npm-cache");
const cliPackageSpec = process.env.TOPOGRAM_CLI_PACKAGE_SPEC || defaultCliPackageSpec();

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(npmCache, { recursive: true });

run("npm", ["install", "--prefix", workRoot, "--silent", "--no-audit", "--ignore-scripts", "--package-lock=false", cliPackageSpec]);
const topogramBin = path.join(workRoot, "node_modules", ".bin", process.platform === "win32" ? "topogram.cmd" : "topogram");
run(topogramBin, ["generator", "check", root]);

function run(command, args) {
  const result = childProcess.spawnSync(command, args, {
    cwd: workRoot,
    encoding: "utf8",
    env: childEnv()
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(" ")}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_package_") || key.startsWith("npm_lifecycle_")) {
      delete env[key];
    }
  }
  delete env.INIT_CWD;
  delete env.npm_config_local_prefix;
  delete env.npm_config_prefix;
  env.npm_config_cache = npmCache;
  env.PATH = cleanPath(process.env.PATH || "", root);
  return env;
}

function cleanPath(value, packageRoot) {
  const blocked = new Set([
    path.join(packageRoot, "node_modules", ".bin"),
    path.resolve(packageRoot, "node_modules", ".bin")
  ]);
  return value.split(path.delimiter).filter((entry) => entry && !blocked.has(path.resolve(entry))).join(path.delimiter);
}

function defaultCliPackageSpec() {
  const version = fs.readFileSync(path.join(root, "topogram-cli.version"), "utf8").trim();
  if (!version) {
    throw new Error("topogram-cli.version must contain the Topogram CLI version used by generator verification.");
  }
  return `@topogram/cli@${version}`;
}
