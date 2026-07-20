#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 && "$(uname -s)" == Linux ]] || { printf 'Linux root fixture is required\n' >&2; exit 1; }
command -v visudo sudo useradd userdel >/dev/null
root="$(mktemp -d /tmp/peilv-effective-sudoers.XXXXXX)"; fragment=/etc/sudoers.d/peilv-effective-test; runner_sudoers=/etc/sudoers.d/runner; runner_mode=''
cleanup(){ rm -f -- "$fragment"; [[ -z "$runner_mode" ]] || chmod "$runner_mode" "$runner_sudoers"; rm -rf -- "$root"; for user in peilv-audit peilv-deploy peilv-rollback; do id "$user" >/dev/null 2>&1 && userdel "$user" || true; done; visudo -c >/dev/null || true; }
trap cleanup EXIT
if [[ -f "$runner_sudoers" && ! -L "$runner_sudoers" ]]; then runner_mode="$(stat -c %a "$runner_sudoers")"; chmod 0440 "$runner_sudoers"; fi
for user in peilv-audit peilv-deploy peilv-rollback; do ! id "$user" >/dev/null 2>&1 || { printf 'Fixture user already exists: %s\n' "$user" >&2; exit 1; }; useradd --system --no-create-home --shell /usr/sbin/nologin "$user"; done
install -d -o root -g root -m 0755 "$root/includes" "$root/nested"
install -o root -g root -m 0440 infra/deploy/peilv-sudoers "$root/nested/new"
cat >"$root/includes/aliases" <<'EOF'
# /usr/local/sbin/peilv-control deploy * is commentary, never authorization.
User_Alias UNRELATED_USERS = root
Cmnd_Alias UNRELATED_COMMANDS = /usr/bin/true
EOF
cat >"$root/includes/nested" <<EOF
@include "$root/nested/new"
EOF
cat >"$fragment" <<EOF
@includedir $root/includes
EOF
chown -R root:root "$root" "$fragment"; chmod 0440 "$root/includes/aliases" "$root/includes/nested" "$fragment"
visudo -c >/dev/null
assert_user(){ local user="$1"; shift; local listing count; listing="$(sudo -l -U "$user")"; ! grep -Eq '/usr/local/sbin/peilv-control (preflight|deploy|rollback) \*' <<<"$listing"; for command in "$@"; do grep -F "/usr/local/sbin/peilv-control $command *" <<<"$listing" >/dev/null; done; count="$(grep -Fc '/usr/local/sbin/peilv-control ' <<<"$listing")"; [[ "$count" == "$#" ]] || { printf 'Unexpected effective peilv command count for %s: %s\n' "$user" "$count" >&2; exit 1; }; }
assert_user peilv-audit preflight-v3
assert_user peilv-deploy deploy-v3 deploy-status-v2
assert_user peilv-rollback rollback-v2 rollback-status-v2
cat >"$root/includes/bypass" <<'EOF'
User_Alias PEILV_BYPASS = peilv-audit
Cmnd_Alias PEILV_OLD = /usr/local/sbin/peilv-control preflight *
PEILV_BYPASS ALL=(root) NOPASSWD: PEILV_OLD
EOF
chown root:root "$root/includes/bypass"; chmod 0440 "$root/includes/bypass"; visudo -c >/dev/null
sudo -l -U peilv-audit | grep -F '/usr/local/sbin/peilv-control preflight *' >/dev/null
rm -f -- "$root/includes/bypass"; visudo -c >/dev/null
printf 'effective sudoers exact ABI verified\n'
