// Windows only: the detached process that `bg start` launches.
// A detached cmd.exe loses output redirected to a file (tested: 0 bytes in the log), while a detached node
// keeps it. So bg starts this script detached with the log as stdout/stderr; it runs the real command
// through the shell, not detached, and the command inherits the log. It stays alive as long as the command:
// when it exits or is killed (bg stop uses taskkill /T), Windows ends the command with it.
import { spawn } from "node:child_process";

const command = process.argv[2];
if (!command) process.exit(2);
const child = spawn(command, { shell: true, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
child.on("error", (error) => {
  console.error(`bg: could not start: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
