# Process isolation on Linux

Octopus's Linux backend uses AppArmor to enforce a process's declared read, write, execute,
network, local IPC and signal authority. The same launch path serves verifier
scripts, interface lives and tool processes. A missing platform service or a
refused profile stops the launch before the target executes. Full-host grants
and an explicitly disabled sandbox keep their declared behavior.

AppArmor retains pathname permissions across atomic file replacement. Exact
invocation paths remain exact: the publication protocol receives its own
directory and filename permissions without granting neighboring files. Before
exec, the native launcher creates only the required ancestor and publication
directories, as the ordinary user and without following symlinks. The resulting
profile grants directory reads and locks; creation never becomes permission to
delete or change an otherwise ungranted parent. Preparation failure may leave
the directories it already created, but never executes the target. Runtime
libraries, executable interpreters and operating-system resources are included
in the process's runtime closure.

## Build prerequisites

Linux workspace checks and the [terminal build](cli.md#build-and-open) require
Rust, Node.js 24 or newer, a C toolchain, pkg-config, and the OpenSSL, SQLite
and ALSA development headers. On Debian/Ubuntu:

```sh
sudo apt-get install build-essential pkg-config libssl-dev libsqlite3-dev libasound2-dev
```

ALSA headers are needed by the audio capability built with the workspace and
CLI distribution, even when the runtime is used headlessly. These build
prerequisites are separate from the process-isolation service below.

## Install the platform component

The backend requires Linux 6.5 or later, AppArmor 4 or later, the AppArmor 4.0
policy ABI, systemd and cgroup v2. It has no distribution-specific execution
branch. The installation must provide `/usr/sbin/apparmor_parser`,
`/etc/apparmor.d/abi/4.0` and `apparmor.service`. Enforced launches are unavailable
on systems without these prerequisites.

Install the distribution's AppArmor package as an administrator. For example,
on Ubuntu:

```sh
sudo apt-get install apparmor
```

Build the service on the Linux machine from the same checkout as Octopus:

```sh
cargo build --locked --release -p octopus-linux-process-authority
```

Install it for the Unix account that will run Octopus, replacing `operator`
with that account's login:

```sh
sudo sh registry/worker_environment_kind/process_session/packages/octopus-linux-process-authority/install-linux.sh \
  "$PWD/target/release/octopus-linux-process-authority" operator
```

Start a new login session so the account receives its `octopus-process` group.
Run Octopus as that account. The service does not start Octopus, execute tool
commands or change their Unix user. Its socket is available only to root and
members of that group. Group membership authorizes use of the platform service;
Octopus still forms every run's grant from its own declarations.

The service owns the profile compiler and a delegated cgroup subtree. Compiler
warnings are errors, including a rule the kernel cannot enforce. A launch retains
its preparation connection until attachment. The service checks kernel-reported
Unix credentials and a peer pidfd, the preparing process's identity and current
confinement. It briefly holds the single-threaded launcher in a ptrace stop while
attaching it to its cgroup, so the PID cannot be recycled during the attachment.
Attachment admits only the preparing process itself or its actual child. The
launcher applies the profile before executing the declared program. Ordinary confined
processes cannot request new profiles; only a process whose declaration grants
sandbox delegation may do so. Requests from another user namespace are refused.

A process without network or local IPC authority may still create unnamed
stream socket pairs, which language runtimes use to wake their own event loops.
It cannot bind or connect an abstract socket. AppArmor mediates a pathname
socket through the file rule of its path, so such a process reaches one only
where its declared file authority already lets it write that path. The service's
control socket is granted by path to a process with sandbox delegation and
denied by path to every other process.

Library tests that launch confined processes (including `octopus-verifiers`) also
require this service to be installed and running. Without it they fail closed;
installing the distribution AppArmor package alone is not sufficient.

## Process lifetime and recovery

A profile stays installed while its preparation connection is open or its
cgroup contains processes. Descendants remain in that cgroup across forks,
executions and new process groups. This includes a command keeper that outlives
the tool process which created it. The service unloads the profile only after
both conditions have ended. A failed cleanup retains the profile and reports
the error.

Service restart preserves existing profiles, cgroups and their root-owned
records under `/run/octopus-process-authority/leases`. It resumes collection
from those records without restarting commands. Stopping the service prevents
new confined launches; it does not remove confinement from existing processes.
Do not remove its retained state while those processes are alive.

Trusted workspace executors invoke the same installed executable in its
unprivileged `exec` mode. It projects the formed room's readable and writable
roots, operating-system runtime resources, protected read-only subpaths and
network ceiling into another AppArmor profile, then replaces itself with the
command. The command keeps its PID and streams and receives no sandbox-delegation
authority. Protected paths remain protected when absent or atomically replaced;
their ancestor directories cannot be renamed or removed to evade that protection.
No filesystem mount or second sandbox backend is involved.

## Diagnostics and scope

```sh
systemctl status octopus-process-authority.service
journalctl -u octopus-process-authority.service
```

The service reports profile compilation, peer identity, attachment and cleanup
errors. It does not substitute an unconfined launch when isolation is
unavailable. Distribution AppArmor policy and user-namespace restrictions remain
in force; they are not disabled by the installer.

This component supplies process isolation. It does not convert a macOS Home,
install Linux versions of its providers or make macOS-only integrations
available. Compose a fresh Home with packages and host paths for the target
machine; existing Homes and their execution evidence are not migrated.

## Running the headless runtime under systemd

A hardened systemd unit template is provided at
[`packaging/linux/octopus-runtime.service`](../packaging/linux/octopus-runtime.service).
It runs `octopus up` as a dedicated non-root `octopus` user in the
`octopus-process` group, with `Restart=on-failure`, `RestartSec=5s`,
`TimeoutStopSec=60s`, `UMask=0077`, and read-only OS directories
(`ProtectSystem=full`, `NoNewPrivileges=yes`).

1. Create the service account and directories (install `octopus-process-authority.service`
   first so the `octopus-process` group exists, or override `SupplementaryGroups=` in a
   systemd drop-in if running without AppArmor process isolation):

```sh
sudo useradd --system --create-home --home-dir /var/lib/octopus --shell /usr/sbin/nologin octopus
sudo install -d -o octopus -g octopus -m 0700 /var/lib/octopus/.octopus
sudo install -d -o root -g root -m 0755 /opt/octopus /etc/octopus
```

2. Install either a release tarball (`Octopus-<version>-linux-<arch>.tar.gz`) or a local
   `npm --prefix app run build:cli` output under `/opt/octopus/releases/<release>` and point
   `/opt/octopus/current` to it:

```sh
sudo ln -sfn /opt/octopus/releases/<release> /opt/octopus/current
```

   To run directly from a checkout's `app/build/cli/runtime` directory or with a different
   service user/Home, place overrides in `/etc/octopus/runtime.env` (`chmod 0600`) and a
   systemd drop-in (`sudo systemctl edit octopus-runtime.service`).

3. Install and start the unit:

```sh
sudo install -o root -g root -m 0644 packaging/linux/octopus-runtime.service /etc/systemd/system/octopus-runtime.service
sudo systemctl daemon-reload
sudo systemctl enable --now octopus-runtime.service
systemctl status octopus-runtime.service
journalctl -u octopus-runtime.service -f
```

Use `octopus restart` (or `systemctl restart octopus-runtime.service`) when reloading the
runtime. Because the unit uses `Restart=on-failure`, `octopus down` performs a clean exit
`0` and leaves the service stopped until started again.

## Safe self-update on Linux

`app/scripts/safe-self-update.cjs` automatically selects `--target=cli` on Linux (or pass
`--target=cli` explicitly on any host). It stages into `runtime.staging` without touching
the live runtime, checks binary SHA-256 digests from `runtime-build-receipt.json` and
runs `octopus doctor`, guards against open turns in the movement ledger, swaps atomically
(directory rename for `app/build/cli/runtime`, or single-rename symlink replacement when
the live path is a symlink), requests `RuntimeControlRequest::Restart` over the control
socket, waits for `ready`, and rolls back automatically if any previously healthy
interface fails.

From a checkout running out of `app/build/cli/runtime`:

```sh
node app/scripts/safe-self-update.cjs status --target=cli
node app/scripts/safe-self-update.cjs build --target=cli
node app/scripts/safe-self-update.cjs verify --target=cli
node app/scripts/safe-self-update.cjs restart --target=cli --swap \
  --systemd-unit=octopus-runtime.service \
  --caller-run=<run id> --detach --log=/tmp/octopus-self-update.log
```

Options useful on headless Linux hosts:

- `--build-root=<dir>`: select a custom root containing `runtime` (plain directory or
  symlink), `runtime.staging`, `runtime.prev`, and `runtime.failed`.
- `--systemd-unit=<unit>` and `--systemd-scope=system|user`: fall back to
  `systemctl [--user] restart <unit>` if the control socket becomes unreachable during
  restart or rollback recovery. Pass `--restart-mode=systemd` to always restart via
  `systemctl` after the turn guard and swap.
- `--no-smoke`: skip the disposable-Home smoke test during `verify` when only checking
  receipt hashes and `octopus doctor` against the configured Home.

The platform contracts are documented by
[AppArmor](https://apparmor.net/man/4.0/apparmor.d/), its
[policy loader](https://manpages.ubuntu.com/manpages/noble/man8/apparmor_parser.8.html)
and the Linux kernel's
[cgroup v2 interface](https://docs.kernel.org/admin-guide/cgroup-v2.html).
