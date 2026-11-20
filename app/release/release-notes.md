Octopus {{version}} for macOS 14 or later ({{architecture}}). The app includes the runtime, the bundled packages, and the pinned Codex CLI it uses as its first provider; nothing else needs to be installed except the Command Line Tools for Xcode.

## Install

In Terminal:

```sh
curl -fsSL https://github.com/octopus-sios/octopus-os/releases/download/v{{version}}/install.sh | OCTOPUS_VERSION={{version}} sh
```

The installer checks the SHA-256 of the disk image against `checksums.txt` and copies `Octopus.app` to `/Applications` (or `~/Applications` when `/Applications` is not writable).

To install by hand, download `Octopus-{{version}}-macos-{{architecture}}.dmg`, drag Octopus to Applications, and before the first launch run:

```sh
xattr -dr com.apple.quarantine /Applications/Octopus.app
```

This build is ad-hoc signed and not notarized by Apple. Without that command macOS refuses to open it, and the tools Octopus copies into your Home would stay quarantined as well. Do not open Octopus from the disk image itself.

## Requirements

- macOS 14 or later.
- Command Line Tools for Xcode: `xcode-select --install`. Octopus runs `python3` and `git` from them.
- A ChatGPT account for Sign in with ChatGPT. If Codex CLI is already signed in on this Mac, Octopus uses the same sign-in in `~/.codex`.

## Linux headless CLI

For Linux (`x86_64`), download `Octopus-{{version}}-linux-x64.tar.gz` and verify it against
`Octopus-{{version}}-linux-x64.tar.gz.sha256` (or `checksums.txt`):

```sh
sha256sum -c Octopus-{{version}}-linux-x64.tar.gz.sha256
tar -xzf Octopus-{{version}}-linux-x64.tar.gz
```

The archive includes the headless runtime (`bin/octopus`: `up`, `down`, `restart`, `doctor`,
`project-ee-policies`), the Linux AppArmor process-authority binary
(`bin/octopus-linux-process-authority`), bundled registry packages, pinned Linux Codex CLI,
and systemd/installer templates under `packaging/linux/` (`octopus-runtime.service`,
`octopus-process-authority.service`, `install-linux.sh`). See
[Linux setup](https://github.com/octopus-sios/octopus-os/blob/v{{version}}/docs/linux.md) and
[Terminal client](https://github.com/octopus-sios/octopus-os/blob/v{{version}}/docs/cli.md).

Setup, Home location, and diagnostics: [Getting started](https://github.com/octopus-sios/octopus-os/blob/v{{version}}/docs/getting-started.md). Known problems: [Troubleshooting](https://github.com/octopus-sios/octopus-os/blob/v{{version}}/TROUBLESHOOTING.md).
