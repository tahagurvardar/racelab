//! Who owns RaceLab's one recording slot.
//!
//! RaceLab records one session at a time. FH6 and F1 25 have separate
//! recorders, listeners and formats, so something has to decide which of
//! them may record when both games are sending. The policy is deliberately
//! the simplest deterministic one:
//!
//! > The first recorder to claim the slot keeps it until its recording is
//! > finalized. A claim by the other game while it is held is refused and
//! > counted. Nothing is preempted, and nothing starts silently when the
//! > slot frees up: a refused game records its next session, not the rest of
//! > the current one.
//!
//! Claims and releases are made by the recorders themselves, on their own
//! threads, under one short mutex section that never touches disk.
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingGame {
    Fh6,
    F1_25,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Owner {
    pub game: RecordingGame,
    /// The owning recorder's RaceLab session id.
    pub session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct OwnerStatus {
    pub owner: Option<Owner>,
    /// Claims refused because the other game held the slot, per game.
    pub fh6_refused: u64,
    pub f1_25_refused: u64,
}

#[derive(Debug, Default)]
pub struct RecordingOwner {
    state: Mutex<OwnerStatus>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

impl RecordingOwner {
    /// Claims the slot for `game`. Succeeds when the slot is free or already
    /// held by `game` (a recorder replacing its own session); refused, and
    /// counted, when the other game holds it.
    pub fn claim(&self, game: RecordingGame, session_id: &str) -> bool {
        let mut state = lock(&self.state);
        match &state.owner {
            Some(owner) if owner.game != game => {
                match game {
                    RecordingGame::Fh6 => state.fh6_refused = state.fh6_refused.saturating_add(1),
                    RecordingGame::F1_25 => {
                        state.f1_25_refused = state.f1_25_refused.saturating_add(1)
                    }
                }
                false
            }
            _ => {
                state.owner = Some(Owner {
                    game,
                    session_id: session_id.to_string(),
                });
                true
            }
        }
    }

    /// Releases the slot if `game` holds it for `session_id`. A release for a
    /// session that does not hold the slot changes nothing.
    pub fn release(&self, game: RecordingGame, session_id: &str) {
        let mut state = lock(&self.state);
        if state
            .owner
            .as_ref()
            .is_some_and(|owner| owner.game == game && owner.session_id == session_id)
        {
            state.owner = None;
        }
    }

    pub fn owner(&self) -> Option<Owner> {
        lock(&self.state).owner.clone()
    }

    pub fn status(&self) -> OwnerStatus {
        lock(&self.state).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_claim_is_sticky_until_released() {
        let owner = RecordingOwner::default();
        assert!(owner.claim(RecordingGame::Fh6, "a"));
        assert!(!owner.claim(RecordingGame::F1_25, "b"));
        assert_eq!(owner.owner().unwrap().game, RecordingGame::Fh6);
        // A release for a session that does not hold the slot is ignored.
        owner.release(RecordingGame::F1_25, "b");
        owner.release(RecordingGame::Fh6, "other");
        assert_eq!(owner.owner().unwrap().session_id, "a");
        owner.release(RecordingGame::Fh6, "a");
        assert!(owner.owner().is_none());
        assert!(owner.claim(RecordingGame::F1_25, "b"));
        assert!(!owner.claim(RecordingGame::Fh6, "c"));
        let status = owner.status();
        assert_eq!(status.fh6_refused, 1);
        assert_eq!(status.f1_25_refused, 1);
    }

    #[test]
    fn a_recorder_may_replace_its_own_session() {
        let owner = RecordingOwner::default();
        assert!(owner.claim(RecordingGame::Fh6, "a"));
        assert!(owner.claim(RecordingGame::Fh6, "b"));
        assert_eq!(owner.owner().unwrap().session_id, "b");
    }
}
