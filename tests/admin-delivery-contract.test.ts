import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("administrator delivery contract", () => {
  it("keeps the bootstrap package command bound to the safe local CLI", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts["admin:bootstrap"]).toBe("node ./scripts/admin-bootstrap.mjs");
    const createRelease = await readFile(new URL("../scripts/create-release.sh", import.meta.url), "utf8");
    const verifyRelease = await readFile(new URL("../scripts/verify-release.sh", import.meta.url), "utf8");
    expect(createRelease).toContain("allowed_release_script_paths=(scripts/admin-bootstrap.mjs scripts/run-migrations.mjs)");
    expect(verifyRelease).toContain("packageJson?.scripts?.[\"admin:bootstrap\"]");
  });

  it("machine-checks the controlled OpenResty boundary", async () => {
    const preflight = await readFile(new URL("../scripts/production-preflight.sh", import.meta.url), "utf8");
    expect(preflight).toContain('(( ${#admin_rate_secret} >= 32 ))');
    expect(preflight).toContain('admin_trust_proxy="$(read_env_value ADMIN_TRUST_PROXY)"');
    expect(preflight).toContain('cp "$verified_tree/infra/openresty/peilv.conf" "$candidate_template"');
    expect(preflight).toContain('"$openresty_control" test');
    expect(preflight).toContain('Production port 5000 must listen only on loopback');
    expect(preflight).toContain('proxy_set_header[[:space:]]+X-Forwarded-For');
    expect(preflight).toContain("active_openresty_hash");
    expect(preflight).toContain("openssl x509 -checkend 604800");
    expect(preflight).toContain('openssl x509 -checkhost "$public_host"');
    expect(preflight).toContain("tls_key_match");
    expect(preflight).toContain("tls_private_key_mode");
  });

  it("requires bootstrap token cleanup only after an administrator exists", async () => {
    const preflight = await readFile(new URL("../scripts/production-preflight.sh", import.meta.url), "utf8");
    expect(preflight).toContain('[[ "$admin_count" =~ ^[1-9][0-9]*$ ]]');
    expect(preflight).toContain('admin_bootstrap_token="$(read_env_value ADMIN_BOOTSTRAP_TOKEN)"');
    expect(preflight).toContain('[[ "$admin_count" == 0 ]]');
    expect(preflight).toContain('[[ -n "$(read_env_value ADMIN_BOOTSTRAP_TOKEN)" ]]');
    expect(preflight).toContain("to_regclass(");
    expect(preflight).toContain("admin_count=0");
  });

  it("binds production and candidate application processes to loopback", async () => {
    const start = await readFile(new URL("../scripts/start.sh", import.meta.url), "utf8");
    const deploy = await readFile(new URL("../scripts/deploy-production.sh", import.meta.url), "utf8");
    const candidateLifecycle = await readFile(new URL("../scripts/lib/candidate-lifecycle.sh", import.meta.url), "utf8");
    expect(start).toContain("HOSTNAME=127.0.0.1 PORT=${DEPLOY_RUN_PORT}");
    expect(deploy).toContain('source "$candidate_lifecycle_helper"');
    expect(deploy).toContain('candidate_start "$candidate_unit" "$release_id" "$candidate_stage" "$candidate_mount"');
    expect(candidateLifecycle).toContain("HOSTNAME=127.0.0.1 PORT=5001 DEPLOY_RUN_PORT=5001");
    expect(deploy).toContain("sport = :5000");
  });

  it("accepts successful inactive oneshots and validates hardening from the candidate release", async () => {
    const preflight = await readFile(new URL("../scripts/production-preflight.sh", import.meta.url), "utf8");
    expect(preflight).toContain('systemctl cat "$unit"');
    expect(preflight).toContain('unit_contract="$(cat "$verified_tree/infra/systemd/$unit"');
    expect(preflight).not.toContain('unit_contract="$(systemctl cat "$unit"');
    expect(preflight).toContain("/run/peilv-probe-preflight");
  });

  it("keeps rollback application and proxy configuration atomic", async () => {
    const rollback = await readFile(new URL("../scripts/rollback-production.sh", import.meta.url), "utf8");
    expect(rollback).toContain('target_openresty="$target/infra/openresty/peilv.conf"');
    expect(rollback).toContain('install -D -o root -g root -m 0644 "$rendered_openresty" "$openresty_config"');
    expect(rollback).toContain("openresty -t -q");
    expect(rollback).toContain("systemctl reload openresty.service");
    expect(rollback).toContain('sha256sum "$openresty_config"');
    expect(rollback).toContain('if (( openresty_changed == 1 )); then');
    expect(rollback).toContain('ln -s "$current" "$base/current.rollback"');
    expect(rollback).toContain("check_https_edge");
    expect(rollback).toContain("https://%s/api/storage/health");
    expect(rollback).toContain("Set-Cookie:");
    expect(rollback).toContain("Secure");
    const stop = rollback.indexOf("systemctl stop peilv.service", rollback.indexOf("restore_on_failure()"));
    const symlink = rollback.indexOf('ln -s "$current" "$base/current.rollback"', stop);
    const proxy = rollback.indexOf('install -D -o root -g root -m 0644 "$openresty_backup" "$openresty_config"', symlink);
    const start = rollback.indexOf("systemctl start peilv.service", proxy);
    expect(stop).toBeGreaterThan(-1);
    expect(symlink).toBeGreaterThan(stop);
    expect(proxy).toBeGreaterThan(symlink);
    expect(start).toBeGreaterThan(proxy);
  });

  it("keeps the trusted curl helper outside application release mutation", async () => {
    const deploy = await readFile(new URL("../scripts/deploy-production.sh", import.meta.url), "utf8");
    const preflight = await readFile(new URL("../scripts/production-preflight.sh", import.meta.url), "utf8");
    const rollback = await readFile(new URL("../scripts/rollback-production.sh", import.meta.url), "utf8");
    const createRelease = await readFile(new URL("../scripts/create-release.sh", import.meta.url), "utf8");
    const verifyRelease = await readFile(new URL("../scripts/verify-release.sh", import.meta.url), "utf8");
    for (const content of [deploy, rollback]) {
      expect(content).not.toContain("install_release_curl_secret_helper");
      expect(content).not.toMatch(/(?:candidate|target|current)_curl_secret_helper/);
      expect(content).toContain("verify_installed_curl_secret_helper");
    }
    expect(preflight).toContain("active_curl_secret_helper");
    expect(createRelease).not.toContain('cp scripts/lib/curl-secret.sh');
    expect(verifyRelease).not.toContain('scripts/lib/curl-secret.sh');
  });

  it("cleans every operational temporary file on normal and signal exits", async () => {
    const preflight = await readFile(new URL("../scripts/production-preflight.sh", import.meta.url), "utf8");
    expect(preflight).toContain("cleanup_temp_files");
    expect(preflight).toContain("trap 'cleanup_temp_files; exit 129' HUP");
    expect(preflight).toContain("trap 'cleanup_temp_files; exit 130' INT");
    expect(preflight).toContain("trap 'cleanup_temp_files; exit 143' TERM");
    for (const script of ["deploy-production.sh", "rollback-production.sh"]) {
      const content = await readFile(new URL(`../scripts/${script}`, import.meta.url), "utf8");
      expect(content).toContain("cleanup_temp_files");
      expect(content).toContain("trap 'exit 129' HUP");
      expect(content).toContain("trap 'exit 130' INT");
      expect(content).toContain("trap 'exit 143' TERM");
      expect(content.indexOf("cleanup_temp_files")).toBeLessThan(content.indexOf('exit "$status"'));
    }
    const deploy = await readFile(new URL("../scripts/deploy-production.sh", import.meta.url), "utf8");
    expect(deploy).toContain('register_temp_file "$runtime"');
    expect(deploy).toContain('cleanup_probe_runtime "$runtime"');
    expect(deploy).toContain('register_temp_file "$rendered_openresty"');
    expect(deploy).toContain('register_temp_file "$openresty_backup"');
    const rollback = await readFile(new URL("../scripts/rollback-production.sh", import.meta.url), "utf8");
    expect(rollback).toContain('register_temp_file "$headers"');
    expect(rollback).toContain('register_temp_file "$rendered_openresty"');
    expect(rollback).toContain('register_temp_file "$openresty_backup"');
  });

  it("never expands the internal secret into curl arguments", async () => {
    for (const script of ["production-preflight.sh", "deploy-production.sh", "rollback-production.sh", "reconcile-automation.sh"]) {
      const content = await readFile(new URL(`../scripts/${script}`, import.meta.url), "utf8");
      expect(content).not.toMatch(/curl[^\n]*(INTERNAL_API_SECRET|x-internal-api-secret)/);
    }
  });

  it("ships systemd credential and process-hardening contracts", async () => {
    const app = await readFile(new URL("../infra/systemd/peilv.service", import.meta.url), "utf8");
    const reconcile = await readFile(new URL("../infra/systemd/peilv-reconcile.service", import.meta.url), "utf8");
    for (const unit of [app, reconcile]) {
      expect(unit).toContain("LoadCredential=internal-api-secret:/opt/peilv/shared/credentials/internal-api-secret");
      expect(unit).toContain("Environment=NODE_ENV=production");
      expect(unit).toContain("RuntimeDirectory=peilv");
      expect(unit).toContain("NoNewPrivileges=true");
      expect(unit).toContain("ProtectProc=invisible");
      expect(unit).toContain("ProcSubset=pid");
      expect(unit).not.toContain("INTERNAL_API_SECRET=");
    }
  });
});
