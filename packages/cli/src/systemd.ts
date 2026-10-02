// The systemd unit `porch init` installs for Caddy. It's a system unit that
// runs as the user, so Caddy starts at boot without lingering and can read
// folders under their home. Based on Caddy's own unit
// (github.com/caddyserver/dist, init/caddy.service).

/** Caddy's admin API, in Caddy's address form. systemd creates `/run/porchlight` for the user. */
export const MANAGED_ADMIN = "unix//run/porchlight/caddy.sock";

export const UNIT_NAME = "porchlight-caddy.service";

export interface CaddyUnitOptions {
	/** The Caddy binary porch downloaded. */
	caddy: string;
	/** Holds the DNS API token, mode 0600. */
	envFile: string;
	/**
	 * What Caddy loads on its very first start, before porch has applied
	 * anything. After that, `--resume` loads the last config porch applied.
	 */
	initialConfig: string;
	user: string;
}

const quote = (arg: string) => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export const renderCaddyUnit = ({ caddy, envFile, initialConfig, user }: CaddyUnitOptions) =>
	`# Written by \`porch init\`. Running it again rewrites this file.
[Unit]
Description=Caddy for Porchlight
Documentation=https://github.com/oscabriel/porchlight
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=${user}
EnvironmentFile=${envFile}
ExecStart=${[caddy, "run", "--config", initialConfig, "--resume"].map(quote).join(" ")}
Restart=on-failure
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
NoNewPrivileges=true
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
RuntimeDirectory=porchlight
RuntimeDirectoryMode=0700

[Install]
WantedBy=multi-user.target
`;
