-- One row per voter per seat. A later vote on the same seat replaces the earlier one.
CREATE TABLE IF NOT EXISTS votes (
  seat        TEXT NOT NULL,
  voter_hash  TEXT NOT NULL,          -- sha256(salt + cookie id); the raw id never leaves the browser cookie
  ip_hash     TEXT NOT NULL,          -- sha256(salt + day + ip); rotates daily, used only for rate limits
  choice      TEXT NOT NULL,          -- 'c0', 'c1', ... (a listed candidate) or 'alt' (someone else)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (seat, voter_hash)
);
CREATE INDEX IF NOT EXISTS votes_ip ON votes (ip_hash, created_at);

-- "Someone else" suggestions. Names show publicly once enough different voters back them;
-- reasons show only after a maintainer approves them (see README).
CREATE TABLE IF NOT EXISTS alternatives (
  seat        TEXT NOT NULL,
  voter_hash  TEXT NOT NULL,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,          -- lowercased, collapsed whitespace; groups "jane doe" with "Jane  Doe"
  reason      TEXT NOT NULL,
  approved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (seat, voter_hash)
);
CREATE INDEX IF NOT EXISTS alternatives_seat ON alternatives (seat, name_key);
