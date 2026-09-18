# RaceLab

RaceLab is a desktop telemetry and driving-intelligence platform for racing games. The first target is Forza Horizon 6, with future adapters planned for Forza Motorsport and F1.

## V0.1 goal

Prove the transport layer before writing any game parser:

`Game / test sender -> UDP -> Rust listener -> Tauri event -> React UI`

The app currently shows:
- packet count
- packets per second
- datagram size
- sender address
- first 32 bytes as hex

## Windows prerequisites

1. Node.js + pnpm
2. Git
3. Rust MSVC toolchain
4. Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK

Install Rust if needed:

```powershell
winget install --id Rustlang.Rustup
rustup default stable-msvc
```

Check your machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-env.ps1
```

## Run RaceLab

```powershell
pnpm install
pnpm tauri dev
```

In the app, leave the UDP port at `5300` and click **Start listener**.

## Test without FH6

Open a second PowerShell window in the repo:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\send-test-udp.ps1 -Port 5300 -Count 300 -Hz 60
```

Expected result: status changes to `RECEIVING`, packet count increases, packets/sec approaches the selected test rate, and the hex preview changes.

## When FH6 is installed

Configure the game's telemetry/Data Out destination to the same machine and UDP port used by RaceLab. For a game running on this same PC, the destination will normally be `127.0.0.1` and port `5300`.

Do **not** implement a packet parser from assumptions. First capture the actual packet size(s) and a short controlled sample while the car is stationary and while driving. That evidence becomes the V0.2 parser fixture set.

## AI-assistant workflow

- `AGENTS.md` gives Codex the implementation constraints.
- `CLAUDE.md` gives Claude a second-pass architecture/review role.
- ChatGPT owns phase scope, architecture decisions, protocol analysis, and acceptance criteria.

See `docs/ROADMAP.md` for the staged plan.
