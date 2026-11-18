// ptk web: starts the pinned pi-web, refuses to listen beyond this machine without a password.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_WEB_VERSION, webCommand } from "../lib/web.ts";

test("ptk web: pinned pi-web on this machine only, unless a password is set", () => {
  assert.deepEqual(webCommand([], {}, "22.23.2"), { argv: ["-y", `@agegr/pi-web@${PI_WEB_VERSION}`] });
  assert.deepEqual(webCommand(["-p", "8080", "--no-open"], {}, "24.1.0").argv?.slice(2), ["-p", "8080", "--no-open"], "options pass through");
  for (const args of [["-H", "0.0.0.0"], ["--hostname", "192.168.1.5"], ["--hostname=0.0.0.0"]]) assert.match(webCommand(args, {}, "22.23.2").error ?? "", /PI_WEB_PASSWORD/, args.join(" "));
  assert.match(webCommand([], { PI_WEB_HOSTNAME: "0.0.0.0" }, "22.23.2").error ?? "", /PI_WEB_PASSWORD/, "the environment variable counts too");
  assert.ok(webCommand(["-H", "0.0.0.0"], { PI_WEB_PASSWORD: "long-random" }, "22.23.2").argv);
  assert.ok(webCommand(["-H", "localhost"], {}, "22.23.2").argv);
  assert.match(webCommand([], {}, "22.18.0").error ?? "", /22\.19/);
  assert.match(webCommand([], {}, "20.11.0").error ?? "", /22\.19/);
  assert.equal(webCommand([], { PTK_PI_WEB_VERSION: "latest" }, "22.23.2").argv?.[1], "@agegr/pi-web@latest");
  assert.ok(webCommand([], { PTK_PI_WEB_VERSION: "1.0.0 && calc" }, "22.23.2").error, "no shell words through the version");
  for (const a of ["8080&calc", "%PATH%", "a b", '"x"', "x|y", "^x"]) assert.match(webCommand(["-p", a], {}, "22.23.2").error ?? "", /plain words/, a);
});
