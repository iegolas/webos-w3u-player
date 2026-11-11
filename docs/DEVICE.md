# Installing on an LG TV (Developer Mode)

This fork packages as its own webOS app:

| Field | Value |
| --- | --- |
| App id | `com.w3uplayer` |
| Title | W3U Player |
| Vendor | Iegolas |
| Version | from `package.json` (synced into `appinfo.json` by the build) |

The package is sideloaded over the TV's Developer Mode SSH endpoint. There is
no store submission and no account linking beyond a free LG developer account.

## Prerequisites

- **Developer Mode on the TV.** Install the **Developer Mode** app from the LG
  Content Store, sign in with a free account from
  <https://webostv.developer.lge.com/>, and set **Dev Mode Status** to **ON**.
  The TV restarts and the app then shows the TV's IP address and a passphrase.
- **An LG developer account.** It is only used by the Developer Mode app; the
  CLI never sees your password, only the passphrase the TV displays.
- **Same network.** The Mac and the TV must be on the same LAN, and the Mac
  must be able to reach the TV on TCP 9922. Guest Wi-Fi, client isolation, and
  VPNs on the Mac are the usual causes of a failed `ares-device-info`.
- **Node.js 22** for the repo tooling (vitest 5 requires it), and
  `@webos-tools/cli` for the `ares-*` commands.
- **Dev Mode session expiry.** A Developer Mode session is time-limited
  (roughly 1,000 hours / 50 days). When it expires the TV stops accepting the
  SSH key: `ares-device-info` and `ares-install` fail with a connection or
  authentication error. Fix: open the Developer Mode app, sign in again, turn
  Dev Mode back **ON** (the TV restarts), then repeat `ares-setup-device` and
  `ares-novacom --getkey` below with the new passphrase. The old device entry
  and key cannot be reused. Installing a new app version does not extend the
  session, and the session also ends early if the TV is factory reset or the
  Developer Mode app is removed.

## Build the IPK on this Mac

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"
npm install
npm run build      # typecheck + esbuild bundle into dist/
npm run package    # bash build.sh: lint, build, service build, package
```

`npm run package` requires the LG CLI on `PATH`; it aborts with
`ares-package: command not found` (or `ares-package not found`) until
`@webos-tools/cli` is installed. It produces, in the repository root:

- `com.w3uplayer_<version>_all.ipk` — the installable package
  (`dist/` + `build/bundled-service/`, without `preview-libs.js`);
- `com.w3uplayer.manifest.json` — the Homebrew Channel manifest.

`build.sh --install [device]` installs and cold-starts in one step once a
device is registered. Without the CLI, build the bundle with `npm run build`
and run the packaging step on a machine that has it, or install the CLI as
described next.

## Install the CLI (one-time setup)

Do this once per Mac. It is a global install, so the command is explicit:

```bash
npm install -g @webos-tools/cli
ares-package --version
```

If your npm prefix is not on `PATH`, use the `bin` directory npm reports
(`npm prefix -g` + `/bin`) or a Node version manager that puts it there. This
repository does not vendor the CLI and the packaging step is blocked until it
is installed.

## Pair the TV (manual, once per Dev Mode session)

The passphrase is shown by the Developer Mode app on the TV, so this step
cannot be scripted. `192.0.2.10` below is a placeholder for the TV's IP.

```bash
# 1. Register the TV as device "tv" (the insecure default key is required;
#    ares-novacom replaces it next).
ares-setup-device --add tv \
  -i "username=prisoner" -i "host=192.0.2.10" -i "port=9922"

# 2. Authorize: enter the passphrase shown in the Developer Mode app.
ares-novacom --device tv --getkey

# 3. Confirm the link works.
ares-device-info --device tv
```

`ares-setup-device -F -j` lists registered devices; omit `--device tv` from
the other commands to use the default (first) one. If the TV's IP changes
(DHCP), update it with `ares-setup-device --modify tv -i "host=<new-ip>"`.

## Sideload and run

```bash
ares-install --device tv ./com.w3uplayer_<version>_all.ipk
ares-launch  --device tv com.w3uplayer

# Cold restart after an upgrade (see AGENTS.md): webOS keeps the old instance
# suspended through an in-place install, and a plain relaunch resumes that
# stale bundle. Close first, then launch again.
ares-launch --device tv --close com.w3uplayer
ares-launch --device tv com.w3uplayer
```

`build.sh --install tv` performs the install, close, and cold relaunch for you.

## Debug on the TV

```bash
ares-launch  --device tv com.w3uplayer          # if not running
ares-inspect --device tv --open com.w3uplayer   # DevTools page inspector
```

The TV exposes a page-level CDP socket only; app `console.*` output appears in
the inspector it opens (or via `scripts/tv.sh logs --app com.w3uplayer`).
`scripts/tv.sh` reads the default `ares-setup-device` entry, so the device name
and passphrase never need to be copied into commands; set
`TV_DEVICE=<name>` for a non-default device.

## Known manual steps and limitations

- Pairing (`ares-setup-device` + `ares-novacom --getkey`) needs the on-screen
  passphrase and must be repeated when the Dev Mode session is renewed.
- `ares-inspect` opens a page-level inspector only; Playwright's
  `connectOverCDP` does not work against it.
- `scripts/tv.sh`, `benchmarks/tv-runner.mjs`, and the E2E specs now use the
  renamed ids, so they stay in step with `appinfo.json` and
  `bundled-service/src/services.json`.
- The bundled service uses `com.w3uplayer.service`; its log path
  (`com.w3uplayer.service.log`) is what `scripts/tv.sh logs --service`
  tails.
- The Homebrew Channel listing descriptor (`homebrew-repository.json`) was
  removed because it only advertised upstream's id and releases; packaging
  still writes `com.w3uplayer.manifest.json`, and a fork-owned listing
  can be re-added once this repo has its own release URL.
