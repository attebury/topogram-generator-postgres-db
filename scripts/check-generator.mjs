import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(root, ".tmp", "generator-check");
const npmCache = path.join(workRoot, "npm-cache");
const npmrcPath = path.join(workRoot, ".npmrc");
const cliPackageSpec = process.env.TOPOGRAM_CLI_PACKAGE_SPEC || defaultCliPackageSpec();
const authToken = process.env.NODE_AUTH_TOKEN || readGhToken();

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(npmCache, { recursive: true });
writeNpmrc();

run("npm", [
  "exec",
  "--yes",
  "--package",
  cliPackageSpec,
  "--",
  "topogram",
  "generator",
  "check",
  root
]);

function run(command, args) {
  const result = childProcess.spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_userconfig: npmrcPath,
      PATH: process.env.PATH || ""
    }
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

function writeNpmrc() {
  const lines = ["@attebury:registry=https://npm.pkg.github.com"];
  if (authToken) {
    lines.push(`//npm.pkg.github.com/:_authToken=${authToken}`);
  }
  lines.push("");
  fs.writeFileSync(npmrcPath, lines.join("\n"), "utf8");
}

function readGhToken() {
  const result = childProcess.spawnSync("gh", ["auth", "token"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH || "" }
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function defaultCliPackageSpec() {
  const version = fs.readFileSync(path.join(root, "topogram-cli.version"), "utf8").trim();
  if (!version) {
    throw new Error("topogram-cli.version must contain the Topogram CLI version used by generator verification.");
  }
  return `@attebury/topogram@${version}`;
}
