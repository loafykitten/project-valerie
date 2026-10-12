export interface ServerConfig {
  host: string;
  port: number;
  database: string;
  origins: string[];
  timezone: string;
  hostLabel?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const requestedHost = env.VALERIE_HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(requestedHost)) {
    throw new Error(
      "Valerie is private: bind to loopback and use an SSH tunnel or restricted Tailscale Serve for remote access.",
    );
  }
  const host = requestedHost === "localhost" ? "127.0.0.1" : requestedHost;
  const port = Number(env.VALERIE_PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid server port.");
  if (env.VALERIE_ADMIN_TOKEN) {
    throw new Error(
      "Dashboard tokens have been removed. Remove VALERIE_ADMIN_TOKEN and use the private SSH or Tailscale access path.",
    );
  }
  const origins = (env.VALERIE_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",")
    .filter(Boolean)
    .map((origin) => {
      const url = new URL(origin.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin.trim()) {
        throw new Error("Dashboard origins must be exact HTTP(S) origins without paths.");
      }
      return url.origin;
    });
  const hostLabel = env.VALERIE_HOST_LABEL;
  if (
    hostLabel !== undefined &&
    (!hostLabel.trim() || hostLabel.length > 80 || /\p{Cc}/u.test(hostLabel))
  ) {
    throw new Error("The display host label must be 1–80 characters without control characters.");
  }
  const timezone = env.VALERIE_TIMEZONE || "America/Chicago";
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  return {
    host,
    port,
    origins,
    timezone,
    hostLabel,
    database: env.VALERIE_DATABASE || "./data/valerie.sqlite",
  };
}
