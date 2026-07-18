$ErrorActionPreference = "Stop"
if ($env:NODE_ENV -eq "production") { throw "Windows production automation is not supported; use Linux systemd credentials" }
throw "Windows reconcile automation is development-only and disabled; use the Linux systemd timer in production"
