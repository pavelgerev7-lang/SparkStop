-- ====================================================================
-- SparkDrop Database Schema (PostgreSQL / Supabase)
-- Platform for Real-Time Utility Outage Tracking in Bulgaria
-- ====================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 2. Drop Tables if existing (clean migration)
DROP TRIGGER IF EXISTS trg_check_saved_addresses_limit ON saved_addresses;
DROP FUNCTION IF EXISTS check_saved_addresses_limit_func();
DROP TABLE IF EXISTS saved_addresses CASCADE;
DROP TABLE IF EXISTS outages CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- 3. Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(50), -- not unique: optional field, not used for login/identity, and the app stores '' rather than NULL when omitted
    password_hash TEXT,
    password_salt TEXT,
    is_verified BOOLEAN NOT NULL DEFAULT true,
    fcm_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Saved Addresses Table
CREATE TABLE saved_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Not a foreign key: a saved address can belong to either a real
    -- registered user (users.id, a UUID) or a guest device — the app lets
    -- addresses be saved without an account, keyed by a client-generated
    -- device id (crypto.randomUUID(), or a "dev_..." fallback string on
    -- browsers without it) that never has — and never should have — a row
    -- in users at all. A strict UUID+FK column would reject every guest
    -- address outright.
    user_id VARCHAR(255) NOT NULL,
    label VARCHAR(100) NOT NULL, -- e.g., 'Вкъщи', 'Офис', 'Родители'
    city VARCHAR(100) NOT NULL,   -- e.g., 'София', 'Пловдив', 'Варна'
    municipality VARCHAR(100),
    region VARCHAR(100),
    street_name VARCHAR(255) NOT NULL, -- e.g., 'ул. Иван Вазов 12'
    district VARCHAR(100),       -- e.g., 'Център', 'Младост 1'
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    notifications_enabled BOOLEAN NOT NULL DEFAULT false,
    fcm_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Trigger Function: Enforce STRICT limit of maximum 3 saved addresses per user_id
CREATE OR REPLACE FUNCTION check_saved_addresses_limit_func()
RETURNS TRIGGER AS $$
DECLARE
    address_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO address_count
    FROM saved_addresses
    WHERE user_id = NEW.user_id;

    IF address_count >= 3 THEN
        RAISE EXCEPTION 'Достигнахте максималния лимит от 3 запазени адреса за този профил.'
            USING ERRCODE = 'ADDR3';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_saved_addresses_limit
BEFORE INSERT ON saved_addresses
FOR EACH ROW
EXECUTE FUNCTION check_saved_addresses_limit_func();

-- 6. Outages Table
CREATE TABLE outages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    utility_type VARCHAR(50) NOT NULL CHECK (utility_type IN ('electricity', 'water', 'heating', 'gas')),
    provider VARCHAR(100) NOT NULL, -- 'Софийска вода', 'Електрохолд', 'EVN', 'Енерго-Про', 'Топлофикация'
    city VARCHAR(100) NOT NULL,
    region VARCHAR(100), -- oblast/province (e.g. 'Русе', 'Пловдив') — disambiguates settlements that share a name across different regions
    raw_location_text TEXT,
    affected_streets TEXT[] NOT NULL DEFAULT '{}',
    source_url TEXT,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    start_time TIMESTAMPTZ NOT NULL,
    expected_end_time TIMESTAMPTZ NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'scheduled', 'resolved')),
    -- Provider-supplied stable identity for one specific announcement, when
    -- the source exposes one (e.g. ЕРП Север's own "Публикувано на ..."
    -- publish timestamp) — lets upsertOutage() recognize the exact same
    -- announcement on a re-scrape without relying on street-overlap
    -- heuristics, which can't tell apart two genuinely separate
    -- announcements that happen to share a street/village and even an
    -- identical scheduled date. NULL for providers that don't supply one.
    source_announcement_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6b. Geocode Cache — Nominatim lookups are rate-limited (1/sec) and slow to
-- rebuild from scratch; persisting them in Postgres (instead of the local
-- geocoded_streets_cache.json file, which does not survive a redeploy) means
-- a precise street/village coordinate, once resolved, stays resolved.
CREATE TABLE geocode_cache (
    cache_key TEXT PRIMARY KEY,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6c. Scraper Run Stats — durable history of every scrape cycle's own
-- reported found/parsed/saved counts per provider, so a "site is reachable
-- but extraction silently returns 0" regression (the exact failure mode
-- behind the Електрохолд/Софийска вода/ВиК Стара Загора bugs this session
-- — urlHealthService.js's plain HTTP-200 check would never have caught any
-- of them) can be detected automatically instead of waiting for a user
-- report. Plain INSERT, never updated — one row per provider per run.
CREATE TABLE scraper_run_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    found INTEGER NOT NULL DEFAULT 0,
    parsed INTEGER NOT NULL DEFAULT 0,
    saved INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_scraper_run_stats_provider_time ON scraper_run_stats(provider, run_at DESC);

-- 7. Performance Indexes
CREATE INDEX idx_saved_addresses_user_id ON saved_addresses(user_id);
CREATE INDEX idx_saved_addresses_city ON saved_addresses(city);
CREATE INDEX idx_outages_city_status ON outages(city, status);
CREATE INDEX idx_outages_utility_type ON outages(utility_type);
CREATE INDEX idx_outages_affected_streets_gin ON outages USING GIN (affected_streets);

-- 7b. Safety net against duplicate-insert storms: a partial unique index
-- (only over currently-visible rows) hashed via md5() so an unbounded TEXT
-- column never hits btree's ~2.7KB single-value index limit. Confirmed
-- live: a prior status-computation bug made freshly-scraped rows come back
-- already 'resolved', which put them outside upsertOutage()'s own
-- duplicate-search (WHERE status IN ('active','scheduled')) — so the exact
-- same announcement kept re-inserting on every scrape cycle instead of
-- updating, accumulating hundreds of byte-identical rows before the root
-- cause was found. Resolved rows are intentionally excluded from this
-- index: the same wording can legitimately recur in a genuinely separate,
-- later announcement once the prior one has already resolved.
CREATE UNIQUE INDEX idx_outages_active_dedup
  ON outages (provider, city, md5(raw_location_text))
  WHERE status IN ('active', 'scheduled');

-- 8. Trigger to Auto-Update updated_at Column
CREATE OR REPLACE FUNCTION update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();
CREATE TRIGGER trg_outages_updated_at BEFORE UPDATE ON outages FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

-- 9. Notification history ("Съобщения"): created automatically at start-up (config/db.js), listed here for reference.
CREATE TABLE IF NOT EXISTS notification_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    address_id TEXT,
    address_label TEXT,
    city TEXT,
    street TEXT,
    utility_type TEXT,
    message TEXT,
    outage_id TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_log_user ON notification_log (user_id, sent_at DESC);

-- 10. Reminders already pushed (24 h before / 1 h before / ended), one row per device: created automatically at start-up (config/db.js).
CREATE TABLE IF NOT EXISTS outage_reminders (
    dedupe_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    outage_id TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
