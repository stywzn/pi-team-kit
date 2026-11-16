---
name: fast-search
description: Search code and files fast with ripgrep (rg) and fd instead of grep -r / find, and install them when missing. Use when searching a repository, when rg or fd is not found, or when a recursive grep/find was blocked.
---

# Fast search

Prefer pi's built-in `grep` and `find` tools: they run ripgrep and fd, skip `.gitignore`d files, and cap output. In bash use `rg` and `fd` directly.

| Instead of | Use |
|---|---|
| `grep -rn "foo" .` | `rg -n foo` |
| `grep -rli "foo" src` | `rg -li foo src` |
| `grep -r --include='*.ts' foo .` | `rg foo -g '*.ts'` (or `-t ts`) |
| `find . -name '*.md'` | `fd -e md` (or `fd -g '*.md'`) |
| `find . -type d -name node_modules -prune` | `fd -t d node_modules -HI` |
| `ls -R src` | `fd . src` |

Useful flags: `rg -F` literal text, `-w` whole word, `-C 3` context, `--hidden` include dotfiles, `-uu` ignore .gitignore. `fd -H` hidden, `-I` ignored files, `-x cmd {}` run per result, `--changed-within 1d`.

If `rg` or `fd` is missing, run `scripts/ensure-rg-fd.sh` from this skill directory. It links the copies pi already downloaded, or installs them with the system package manager, and prints what it did.
