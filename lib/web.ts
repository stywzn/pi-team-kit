// `ptk web`: pi in the browser through pi-web (github.com/agegr/pi-web), which runs pi's own SDK, so this
// package, its tools and the lead board work there as in the terminal. Pinned to the version tested with it.

export const PI_WEB_VERSION = "0.17.0";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The command that starts pi-web, or why not. Reachable from other machines only with a password. */
export function webCommand(
  args: string[],
  env: Record<string, string | undefined>,
  nodeVersion = process.versions.node,
): { argv: string[]; error?: undefined } | { error: string } {
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) return { error: `pi-web needs Node.js 22.19 or newer; this is ${nodeVersion}.` };
  let host = env.PI_WEB_HOSTNAME ?? "127.0.0.1";
  args.forEach((a, i) => {
    if (a === "-H" || a === "--hostname") host = args[i + 1] ?? host;
    else if (a.startsWith("--hostname=")) host = a.slice(11);
  });
  if (!LOOPBACK.has(host) && !env.PI_WEB_PASSWORD)
    return { error: `Listening on ${host} lets anyone who reaches this machine run commands as you. Set PI_WEB_PASSWORD to a long random password first, and use it only on a trusted network or VPN.` };
  const version = env.PTK_PI_WEB_VERSION || PI_WEB_VERSION;
  if (!/^[\w.-]+$/.test(version)) return { error: `PTK_PI_WEB_VERSION is not a version: ${version}` };
  // npx is a .cmd on Windows, started through cmd.exe: only plain words, nothing it would read as syntax
  const odd = args.find((a) => !/^[\w@+=:,./-]+$/.test(a));
  if (odd !== undefined) return { error: `Unexpected characters in "${odd}": pass pi-web options as plain words (-p 8080, -H 0.0.0.0, --no-open).` };
  return { argv: ["-y", `@agegr/pi-web@${version}`, ...args] };
}
