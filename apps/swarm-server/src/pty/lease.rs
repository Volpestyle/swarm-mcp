use swarm_protocol::state::Lease;

use crate::error::ServerError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingTakeover {
    pub holder: String,
    pub activates_at: i64,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseMutation {
    Unchanged(Option<Lease>),
    Changed(Option<Lease>),
    Pending {
        current: Option<Lease>,
        takeover: PendingTakeover,
    },
}

#[derive(Debug, Clone)]
pub struct LeaseState {
    current: Option<Lease>,
    pending: Option<PendingTakeover>,
    previous_holder: Option<String>,
    last_generation: u64,
}

impl LeaseState {
    pub fn new(current: Option<Lease>) -> Self {
        let last_generation = current.as_ref().map_or(0, |lease| lease.generation);
        Self {
            current,
            pending: None,
            previous_holder: None,
            last_generation,
        }
    }

    pub fn request(
        &mut self,
        holder: &str,
        takeover: bool,
        now: i64,
        grace_ms: i64,
    ) -> Result<LeaseMutation, ServerError> {
        let _ = self.promote_due(now);

        match self.current.as_ref() {
            None => {
                let lease = self.grant(holder, now);
                Ok(LeaseMutation::Changed(Some(lease)))
            }
            Some(current) if current.holder == holder => {
                Ok(LeaseMutation::Unchanged(self.current.clone()))
            }
            Some(_) if !takeover => Err(ServerError::lease_conflict(
                "another client currently holds the PTY lease",
            )),
            Some(current) => {
                let pending = PendingTakeover {
                    holder: holder.to_owned(),
                    activates_at: now.saturating_add(grace_ms),
                    generation: current.generation.saturating_add(1),
                };
                self.pending = Some(pending.clone());
                self.previous_holder = Some(current.holder.clone());
                Ok(LeaseMutation::Pending {
                    current: self.current.clone(),
                    takeover: pending,
                })
            }
        }
    }

    pub fn release(&mut self, holder: &str, now: i64) -> Result<LeaseMutation, ServerError> {
        let _ = self.promote_due(now);

        if let Some(pending) = self.pending.as_ref() {
            if pending.holder == holder
                && self
                    .current
                    .as_ref()
                    .is_none_or(|current| current.holder != holder)
            {
                self.pending = None;
                self.previous_holder = None;
                return Ok(LeaseMutation::Unchanged(self.current.clone()));
            }
        }

        let Some(current) = self.current.as_ref() else {
            return Ok(LeaseMutation::Unchanged(None));
        };
        if current.holder != holder {
            return Err(ServerError::lease_conflict(
                "another client currently holds the PTY lease",
            ));
        }

        if let Some(pending) = self.pending.take() {
            let lease = Lease {
                holder: pending.holder,
                acquired_at: now,
                generation: pending.generation,
            };
            self.last_generation = lease.generation;
            self.current = Some(lease.clone());
            self.previous_holder = Some(holder.to_owned());
            return Ok(LeaseMutation::Changed(Some(lease)));
        }

        if let Some(previous_holder) = self.previous_holder.take() {
            if previous_holder != holder {
                let lease = self.grant(&previous_holder, now);
                return Ok(LeaseMutation::Changed(Some(lease)));
            }
        }

        self.current = None;
        self.previous_holder = None;
        Ok(LeaseMutation::Changed(None))
    }

    pub fn promote_due(&mut self, now: i64) -> Option<Option<Lease>> {
        let pending = self.pending.clone()?;
        if now < pending.activates_at {
            return None;
        }

        let lease = Lease {
            holder: pending.holder,
            acquired_at: pending.activates_at,
            generation: pending.generation,
        };
        self.last_generation = lease.generation;
        self.current = Some(lease.clone());
        self.pending = None;
        Some(Some(lease))
    }

    pub fn promote_matching(
        &mut self,
        now: i64,
        holder: &str,
        generation: u64,
    ) -> Option<Option<Lease>> {
        let pending = self.pending.clone()?;
        if pending.holder != holder || pending.generation != generation {
            return None;
        }
        self.promote_due(now)
    }

    fn grant(&mut self, holder: &str, now: i64) -> Lease {
        let generation = self.last_generation.saturating_add(1);
        let lease = Lease {
            holder: holder.to_owned(),
            acquired_at: now,
            generation,
        };
        self.last_generation = generation;
        self.current = Some(lease.clone());
        self.pending = None;
        self.previous_holder = None;
        lease
    }
}
