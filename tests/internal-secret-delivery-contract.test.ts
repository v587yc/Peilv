import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const shellScripts = ["deploy-production.sh", "production-preflight.sh", "rollback-production.sh", "reconcile-automation.sh"];
const hardening = [
  "NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=strict", "ProtectHome=true",
  "PrivateDevices=true", "ProtectKernelTunables=true", "ProtectKernelModules=true",
  "ProtectControlGroups=true", "RestrictSUIDSGID=true", "LockPersonality=true",
];

describe("production internal secret delivery contract", () => {
  it("routes all application reads through the file-aware resolver", async () => {
    for (const file of ["src/lib/internal-auth.ts", "src/lib/admin-auth.ts", "src/lib/automation/handlers.ts", "src/adapters/backtest-analysis.ts"]) {
      const content = await read(file);
      expect(content, file).toContain("getInternalApiSecret");
      expect(content, file).not.toMatch(/process\.env\.INTERNAL_API_SECRET\b/);
    }
  });

  it.each(["peilv.service", "peilv-reconcile.service", "peilv-dispatch.service"])("uses LoadCredential and complete hardening in %s", async service => {
    const unit = await read(`infra/systemd/${service}`);
    expect(unit).toContain("Environment=NODE_ENV=production");
    expect(unit).toContain("LoadCredential=internal-api-secret:/opt/peilv/shared/credentials/internal-api-secret");
    expect(unit).not.toMatch(/^Environment=INTERNAL_API_SECRET=/m);
    for (const setting of hardening) expect(unit, `${service}: ${setting}`).toContain(setting);
  });

  it("passes a credential argument at every curl-secret helper execution point", async () => {
    let executions = 0;
    for (const name of shellScripts) {
      const content = await read(`scripts/${name}`);
      for (const line of content.split(String.fromCharCode(10))) {
        if (line.includes('| "$curl_secret_helper"') || line.includes('| RUNTIME_DIRECTORY="$runtime" "$curl_secret_helper"')) {
          executions += 1;
          expect(line, `${name}: ${line}`).toContain('"$curl_secret_helper" "$internal_secret_file"');
          if (line.includes("RUNTIME_DIRECTORY")) expect(line).toContain('RUNTIME_DIRECTORY="$runtime"');
        }
        if (line.includes('| "$script_dir/lib/curl-secret.sh"')) {
          executions += 1;
          expect(line, `${name}: ${line}`).toContain('"$script_dir/lib/curl-secret.sh" "$credential_file"');
        }
      }
    }
    expect(executions).toBeGreaterThanOrEqual(2);
    const deploy = await read("scripts/deploy-production.sh");
    expect(deploy).toContain('/usr/local/libexec/peilv/curl-secret.sh "$CREDENTIALS_DIRECTORY/internal-api-secret"');
  });

  it.each(["deploy-production.sh", "rollback-production.sh"])("keeps candidate systemd-run credential-free and strongly sandboxed in %s", async name => {
    const content = await read(`scripts/${name}`);
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    expect(content, name).toContain('source "$candidate_lifecycle_helper"');
    expect(content, name).toContain("candidate_start");
    expect(lifecycle).toContain("candidate_existing_sensitive_path_properties sensitive_path_properties || return 1");
    expect(lifecycle).toContain('"${sensitive_path_properties[@]}"');
    const propertiesStart = lifecycle.indexOf("candidate_existing_sensitive_path_properties() {");
    const propertiesEnd = lifecycle.indexOf("candidate_validate_unit_release()", propertiesStart);
    const propertiesBlock = lifecycle.slice(propertiesStart, propertiesEnd);
    expect(propertiesBlock).toContain('output+=(--property="InaccessiblePaths=$path")');
    const start = lifecycle.indexOf("candidate_start() {");
    const end = lifecycle.indexOf("candidate_wait_ready()", start);
    const blocks = [lifecycle.slice(start, end).replace(/=yes\b/g, "=true")];
    for (const block of blocks) {
      expect(block, name).not.toContain("LoadCredential");
      expect(block, name).not.toContain("EnvironmentFile");
      expect(block, name).not.toContain("CREDENTIALS_DIRECTORY");
      expect(block, name).not.toContain("storage/health");
      expect(block, name).not.toContain("INTERNAL_API_SECRET=");
      for (const setting of ["NODE_ENV=production", "RuntimeDirectory=peilv-candidate", "NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=strict", "ProtectHome=true", "ProtectProc=invisible", "ProcSubset=pid", "PrivateDevices=true", "ProtectKernelTunables=true", "ProtectKernelModules=true", "ProtectControlGroups=true", "RestrictSUIDSGID=true", "LockPersonality=true", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "BindReadOnlyPaths="]) {
        expect(block, `${name}: ${setting}`).toContain(setting);
      }
    }
  });

  it("does not export app.env or place secret material in argv", async () => {
    for (const name of shellScripts) {
      const content = await read(`scripts/${name}`);
      expect(content, name).not.toMatch(/\bset\s+-a\b/);
      expect(content, name).not.toMatch(/export\s+INTERNAL_API_SECRET=/);
      expect(content, name).not.toMatch(/(?:curl|systemd-run|\/usr\/bin\/env)[^\n]*(?:INTERNAL_API_SECRET=|x-internal-api-secret)/i);
    }
  });

  it("opens, validates and reads a credential through the same descriptor", async () => {
    const source = await read("src/lib/internal-secret.ts");
    expect(source).toMatch(/openSync|promises\.open/);
    expect(source).toMatch(/fstatSync|\.stat\(\)/);
    expect(source).toMatch(/readFileSync\([^"'`]*\b(?:fd|descriptor|handle)\b|\.readFile\(/);
    expect(source).not.toMatch(/readFileSync\(path\s*,/);
  });

  it("rejects unsafe credential parent directories before opening the file", async () => {
    const source = await read("src/lib/internal-secret.ts");
    expect(source).toMatch(/dirname|parent/i);
    expect(source).toMatch(/isSymbolicLink|realpath/i);
    expect(source).toMatch(/0o0?22|0o0?02|mode\s*&/);
  });

  it("keeps the helper file-only and scrubs inherited secret variables", async () => {
    const helper = await read("scripts/lib/curl-secret.sh");
    expect(helper).toContain('credential_file="${1:?$usage}"');
    expect(helper).not.toMatch(/\$\{INTERNAL_API_SECRET(?::|})/);
    expect(helper).toContain("unset INTERNAL_API_SECRET INTERNAL_API_SECRET_FILE");
    expect(helper).toContain('[ ! -f "$credential_file" ] || [ -L "$credential_file" ]');
    expect(helper).toContain('[ "$mode" = 440 ]');
    expect(helper).toContain('[ "$mode" = 600 ]');
    expect(helper).toContain("Runtime credential must be root-owned 0440");
    expect(helper).toContain('--config "$config_file"');
  });

  it.each(["deploy-production.sh", "rollback-production.sh"])("never replaces the trusted host helper from an application release in %s", async name => {
    const content = await read(`scripts/${name}`);
    expect(content).not.toContain("install_release_curl_secret_helper");
    expect(content).not.toMatch(/(?:candidate|target|current)_curl_secret_helper/);
    expect(content).toContain("verify_installed_curl_secret_helper");
  });

  it.each(["deploy-production.sh", "rollback-production.sh"])("uses a trusted systemd credential probe only for formal health in %s", async name => {
    const content = await read(`scripts/${name}`);
    const formal = content.slice(content.indexOf("check_formal_application()"), content.indexOf("check_https_edge()"));
    expect(formal).toContain("systemd-run");
    expect(formal).toContain("LoadCredential=internal-api-secret:$internal_secret_file");
    expect(formal).toContain('/usr/local/libexec/peilv/curl-secret.sh "$CREDENTIALS_DIRECTORY/internal-api-secret"');
  });

  it("fails closed for Windows production automation without parsing .env secrets", async () => {
    for (const name of ["start-production.cmd", "dispatch-automation.ps1", "reconcile-automation.ps1"]) {
      const content = await read(`scripts/${name}`);
      expect(content, name).toContain("Windows production automation is not supported");
      expect(content, name).not.toMatch(/Get-Content[\s\S]*INTERNAL_API_SECRET|INTERNAL_API_SECRET=/);
    }
  });

  it("preflight validates systemd capability, credential parents and base64url format", async () => {
    const preflight = await read("scripts/production-preflight.sh");
    expect(preflight).toContain("systemd_credentials_version");
    expect(preflight).toContain("systemd_version >= 247");
    expect(preflight).toContain("secret_parent_safe");
    expect(preflight).toContain("^[A-Za-z0-9_-]+$");
    expect(preflight).toContain("INTERNAL_API_SECRET_FILE");
    expect(preflight).toContain("CREDENTIALS_DIRECTORY");
    expect(preflight).toContain("NODE_OPTIONS");
  });

  it("ships dispatch with a distinct user, runtime and timer", async () => {
    const unit = await read("infra/systemd/peilv-dispatch.service");
    const timer = await read("infra/systemd/peilv-dispatch.timer");
    expect(unit).toContain("User=peilv-dispatch");
    expect(unit).toContain("RuntimeDirectory=peilv-dispatch");
    expect(unit).toContain("LoadCredential=internal-api-secret:");
    expect(timer).toContain("Unit=peilv-dispatch.service");
  });

  it("binds active helper and systemd units to the current release", async () => {
    const preflight = await read("scripts/production-preflight.sh");
    expect(preflight).toContain("active_curl_secret_helper");
    expect(preflight).toContain("active_systemd_unit_hashes");
    expect(preflight).toContain("Installed systemd units are not root-owned regular single-link files");
  });

  it("keeps rotation implementation dry-run only", async () => {
    const rotation = await read("scripts/rotate-internal-secret.sh");
    expect(rotation).toContain('"${1:-}" == --dry-run');
    expect(rotation).toContain("DRY-RUN ONLY");
    expect(rotation).not.toMatch(/read .*internal-api-secret|cat .*internal-api-secret|mv .*internal-api-secret|systemctl restart/);
  });
});
