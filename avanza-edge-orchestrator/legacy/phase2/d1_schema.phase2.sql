-- PROJECT AVANZA / D1 cold-history schema
-- apply: npx wrangler d1 execute avanza-history --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS telemetry_history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	ingests INTEGER,
	wan_down_30m INTEGER,
	devices INTEGER,
	last_payload_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tel_ts ON telemetry_history(ts);

CREATE TABLE IF NOT EXISTS outage_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	state TEXT NOT NULL,
	detail TEXT,
	confidence REAL
);

CREATE INDEX IF NOT EXISTS idx_outage_ts ON outage_events(ts);

CREATE TABLE IF NOT EXISTS device_daily (
	day TEXT NOT NULL,
	ip TEXT NOT NULL,
	bytes INTEGER NOT NULL DEFAULT 0,
	lane_changes INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, ip)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS fleet_syslog (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	device TEXT NOT NULL,
	line TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_syslog_ts ON fleet_syslog(ts);
CREATE INDEX IF NOT EXISTS idx_syslog_dev ON fleet_syslog(device, ts);

-- retention helper (run monthly from the oracle or by hand):
-- DELETE FROM telemetry_history WHERE ts < (strftime('%s','now') - 7776000);
-- DELETE FROM outage_events   WHERE ts < (strftime('%s','now') - 7776000);
