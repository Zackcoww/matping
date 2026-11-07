# MatPing

A simple, lightweight ping monitor for Windows. One window instead of a stack of `ping -t` cmd windows.

- Save a list of targets (name + IP or host); add, edit, delete, drag to reorder.
- Every target pings non-stop in the background (Windows' own `ping.exe`, no admin needed).
- Each card shows the latest and average latency and a status bar of the last 60 pings:
  green = reply, yellow = latency spike, red = timeout / unreachable.
- Raw `ping` output per card, collapsible.
- Responsive grid: one column in a thin window, many columns full screen.
- Starts with Windows and resumes pinging on launch.

## Install

Download `MatPing_x.y.z_x64-setup.exe` from [Releases](../../releases) and run it. No admin rights needed.

## Build from source

Needs [Rust](https://rustup.rs), Node.js 22+ and pnpm, plus the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for Windows.

```bash
pnpm install
pnpm tauri build
```

The installer lands in `src-tauri/target/release/bundle/nsis/`. Run `pnpm tauri dev` for a dev build.

Built with Tauri 2, React 19, TypeScript and Rust.

## License

[MIT](LICENSE)
