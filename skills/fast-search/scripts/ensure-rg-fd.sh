#!/usr/bin/env bash
# Make `rg` and `fd` available on PATH. Order: already there -> pi's downloaded copies -> fdfind alias -> package manager.
set -euo pipefail

bin="${HOME}/.local/bin"
pi_bin="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin"
mkdir -p "$bin"

have() { command -v "$1" >/dev/null 2>&1; }
link() { ln -sf "$1" "$bin/$2" && echo "linked $2 -> $1"; }

install_pkg() {
  local pkg_rg="ripgrep" pkg_fd="$1"
  if have brew; then brew install ripgrep fd
  elif have apt-get; then sudo -n apt-get install -y ripgrep "$pkg_fd" || { echo "need sudo: run 'sudo apt-get install -y ripgrep fd-find' yourself"; return 1; }
  elif have dnf; then sudo -n dnf install -y ripgrep fd-find
  elif have pacman; then sudo -n pacman -S --noconfirm ripgrep fd
  elif have winget; then winget install -e --id BurntSushi.ripgrep.MSVC && winget install -e --id sharkdp.fd
  elif have cargo; then cargo install ripgrep fd-find
  else echo "no package manager found; install ripgrep and fd manually" >&2; return 1
  fi
}

for tool in rg fd; do
  if have "$tool"; then echo "$tool: $(command -v "$tool")"; continue; fi
  if [ -x "$pi_bin/$tool" ]; then link "$pi_bin/$tool" "$tool"; continue; fi
  if [ "$tool" = fd ] && have fdfind; then link "$(command -v fdfind)" fd; continue; fi
  install_pkg fd-find || true
  [ "$tool" = fd ] && have fdfind && ! have fd && link "$(command -v fdfind)" fd
done

case ":$PATH:" in *":$bin:"*) ;; *) echo "note: add $bin to PATH (e.g. in ~/.bashrc or ~/.zshrc)";; esac
have rg && have fd && echo "ok: rg and fd ready"
