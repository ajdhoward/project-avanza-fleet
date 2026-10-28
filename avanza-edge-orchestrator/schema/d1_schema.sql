-- ============================================================================
-- PROJECT AVANZA — D1 SQLite fleet schema (idempotent; applied via
-- `wrangler d1 execute avanza-telemetry --remote --file=...`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS telemetry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device        TEXT    NOT NULL,
    ts            INTEGER NOT NULL,            -- epoch ms
    mem_total_kb  INTEGER,
    mem_avail_kb  INTEGER,
    conntrack     INTEGER,
    load1         REAL,
    uptime_s      INTEGER,
    plc_tx_mbps   REAL,
    plc_rx_mbps   REAL,
    clients_json  TEXT,
    schema_ver    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry (device, ts DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_ts        ON telemetry (ts);

CREATE TABLE IF NOT EXISTS plc_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    device     TEXT    NOT NULL,               -- local bridge device id
    local_mac  TEXT,
    peer_mac   TEXT    NOT NULL,
    tx_mbps    REAL,
    rx_mbps    REAL,
    atten_db   REAL,
    iface      TEXT,
    status     TEXT
);
CREATE INDEX IF NOT EXISTS idx_plc_ts     ON plc_links (ts DESC);
CREATE INDEX IF NOT EXISTS idx_plc_peer   ON plc_links (device, peer_mac, ts DESC);

CREATE TABLE IF NOT EXISTS speedtests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    device       TEXT    NOT NULL,
    direction    TEXT    NOT NULL DEFAULT 'edge_down',
    mbps         REAL    NOT NULL,
    duration_ms  INTEGER,
    payload_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_speed_ts      ON speedtests (ts DESC);
CREATE INDEX IF NOT EXISTS idx_speed_device  ON speedtests (device, ts DESC);

CREATE TABLE IF NOT EXISTS anomalies (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    device    TEXT    NOT NULL,
    kind      TEXT    NOT NULL,
    severity  TEXT    NOT NULL DEFAULT 'info',  -- info|warn|critical
    detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_anom_ts      ON anomalies (ts DESC);
CREATE INDEX IF NOT EXISTS idx_anom_device  ON anomalies (device, ts DESC);

CREATE TABLE IF NOT EXISTS guest_requests (
    id          TEXT PRIMARY KEY,
    ts          INTEGER NOT NULL,
    device      TEXT    NOT NULL,
    mac         TEXT    NOT NULL,
    hostname    TEXT,
    note        TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending', -- pending|evaluated|applied|rejected
    score       REAL,
    decision    TEXT,
    ttl_expires INTEGER
);
CREATE INDEX IF NOT EXISTS idx_guest_status ON guest_requests (status, ts DESC);

CREATE TABLE IF NOT EXISTS audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    actor   TEXT    NOT NULL,
    action  TEXT    NOT NULL,
    target  TEXT,
    payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
