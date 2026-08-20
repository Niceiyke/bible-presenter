//! Broadcast Engine (Phase 1).
//!
//! The engine is the single authoritative home for every presentation
//! mutation: staging, committing, going live, clearing, overlays (lower-third,
//! props, logo, blackout), settings, timers, and scene application. Both the
//! desktop Tauri command adapters and the Remote Control dispatch route through
//! these `op_*` functions, so desktop and phone callers can never diverge.
//!
//! Engine contract (see `docs/UNIFIED_PRODUCTION_SUITE_PLAN.md` §6 Phase 1):
//! - Every `op_*` acquires the presentation mutation lock and bumps the
//!   presentation revision exactly ONCE per logical mutation, so listeners see
//!   one consistent event per change and stale windows resynchronize.
//! - Every `op_*` returns a [`MutationResult`] carrying the post-mutation
//!   [`PresentationSnapshot`] (plus the committed item / scene payload where
//!   relevant) so command adapters can reply without a second read.
//! - Mutations that persist first are transactional: a persistence failure
//!   aborts before any in-memory state or event is touched, and multi-write
//!   operations compensate the earlier writes.
//! - The engine only mutates authoritative state; it never renders and never
//!   serves IPC directly (command adapters stay thin).
//!
//! The old Tauri command names (`stage_item`, `commit_staged`, `send_live_item`,
//! `apply_scene`, …) are preserved as thin adapters in `commands/` so the
//! frontend contract is unchanged.

pub mod backend;
pub mod client;
pub mod ipc;
pub mod presentation;
pub mod runtime;

pub use presentation::*;
