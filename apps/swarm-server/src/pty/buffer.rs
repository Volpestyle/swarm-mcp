use std::collections::VecDeque;

use swarm_protocol::cursors::PtySeq;
use swarm_protocol::frames::{Frame, FramePayload, PtyAttachRejectedFrame, PtyDataFrame};

#[derive(Debug, Clone)]
struct BufferedChunk {
    seq: PtySeq,
    data: Vec<u8>,
}

#[derive(Debug)]
pub struct ReplayBuffer {
    chunks: VecDeque<BufferedChunk>,
    retained_bytes: usize,
    max_bytes: usize,
    next_seq: PtySeq,
}

impl ReplayBuffer {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            retained_bytes: 0,
            max_bytes,
            next_seq: PtySeq::new(0),
        }
    }

    pub fn push(&mut self, data: &[u8]) -> PtySeq {
        let seq = self.next_seq.next();
        self.next_seq = seq;

        let mut stored = data.to_vec();
        if stored.len() > self.max_bytes {
            stored = stored[stored.len() - self.max_bytes..].to_vec();
        }

        self.retained_bytes += stored.len();
        self.chunks.push_back(BufferedChunk { seq, data: stored });
        self.evict();
        seq
    }

    pub fn replay(
        &self,
        pty_id: &str,
        since_seq: Option<PtySeq>,
    ) -> Result<Vec<Frame>, PtyAttachRejectedFrame> {
        if self.chunks.is_empty() {
            return Ok(Vec::new());
        }

        let earliest_seq = self
            .chunks
            .front()
            .map(|chunk| chunk.seq)
            .unwrap_or_else(|| PtySeq::new(0));

        if let Some(cursor) = since_seq {
            let earliest_allowed = earliest_seq.value().saturating_sub(1);
            if cursor.value() < earliest_allowed {
                return Err(PtyAttachRejectedFrame {
                    pty_id: pty_id.to_owned(),
                    earliest_seq,
                    reason: "requested PTY replay is older than the retained ring buffer"
                        .to_owned(),
                });
            }
        }

        let frames = self
            .chunks
            .iter()
            .filter(|chunk| since_seq.is_none_or(|cursor| chunk.seq.value() > cursor.value()))
            .map(|chunk| {
                Frame::new(FramePayload::PtyData(PtyDataFrame {
                    pty_id: pty_id.to_owned(),
                    seq: chunk.seq,
                    data: chunk.data.clone(),
                }))
            })
            .collect();

        Ok(frames)
    }

    fn evict(&mut self) {
        while self.retained_bytes > self.max_bytes {
            let Some(oldest) = self.chunks.pop_front() else {
                self.retained_bytes = 0;
                break;
            };
            self.retained_bytes = self.retained_bytes.saturating_sub(oldest.data.len());
        }
    }
}
