CREATE TABLE IF NOT EXISTS managed_zones(
  provider_id TEXT NOT NULL,
  zone TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider_id, zone)
);
