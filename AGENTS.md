# RaceLab — Codex instructions

## Mission
Build a reliable desktop telemetry platform. Correct data engineering beats flashy UI.

## Current phase: V0.1 raw UDP capture
- Do not implement or guess the Forza Horizon 6 packet schema until we have captured real packet sizes and sample bytes.
- Keep the Rust listener game-agnostic.
- Preserve a clean adapter boundary for future `fh6`, `forza-motorsport`, and `f1` parsers.
- No AI features in this phase.
- No cloud/backend/auth in this phase.

## Engineering rules
- Frontend: React + TypeScript + Vite.
- Desktop/native layer: Tauri 2 + Rust.
- Strict TypeScript; no `any` without a documented reason.
- Avoid blocking Tauri's UI thread.
- UDP listener errors must surface to the UI instead of panicking.
- Keep networking/parser/storage modules separate as the project grows.
- Add tests for deterministic parsing once a real packet schema is known.
- Prefer small reviewable changes.

## V0.1 acceptance criteria
1. `pnpm tauri dev` opens the app on Windows.
2. Listener can bind a configurable UDP port.
3. `scripts/send-test-udp.ps1` produces visible traffic.
4. UI shows packet count, packets/sec, packet size, source, and hex preview.
5. Listener can stop and restart without restarting the app.
