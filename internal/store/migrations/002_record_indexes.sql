CREATE INDEX IF NOT EXISTS records_owner_idx ON records(provider_id, zone, owner_id);
CREATE INDEX IF NOT EXISTS report_received_idx ON reports(received_at);
