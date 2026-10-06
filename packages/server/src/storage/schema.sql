-- 测斜监测系统 schema（PostgreSQL 16）
-- 幂等：重复执行安全。

CREATE TABLE IF NOT EXISTS probes (
    id          UUID PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS probe_calibrations (
    id               UUID PRIMARY KEY,
    probe_id         UUID NOT NULL REFERENCES probes(id) ON DELETE CASCADE,
    effective_at     TIMESTAMPTZ NOT NULL,
    factor           DOUBLE PRECISION NOT NULL CHECK (factor > 0),
    note             TEXT,
    revision         INTEGER NOT NULL DEFAULT 1,
    superseded       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calibrations_probe_time
    ON probe_calibrations(probe_id, effective_at) WHERE superseded = FALSE;

CREATE TABLE IF NOT EXISTS boreholes (
    id                  UUID PRIMARY KEY,
    code                TEXT NOT NULL UNIQUE,
    depth               DOUBLE PRECISION NOT NULL CHECK (depth > 0),
    spacing             DOUBLE PRECISION NOT NULL CHECK (spacing > 0),
    positive_direction  TEXT NOT NULL,
    checksum_tolerance  DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (checksum_tolerance >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS borehole_thresholds (
    id          UUID PRIMARY KEY,
    borehole_id UUID NOT NULL REFERENCES boreholes(id) ON DELETE CASCADE,
    depth       DOUBLE PRECISION NOT NULL CHECK (depth > 0),
    blue        DOUBLE PRECISION NOT NULL CHECK (blue >= 0),
    yellow      DOUBLE PRECISION NOT NULL CHECK (yellow >= 0),
    red         DOUBLE PRECISION NOT NULL CHECK (red >= 0),
    CHECK (blue < yellow AND yellow < red),
    UNIQUE (borehole_id, depth)
);

CREATE TABLE IF NOT EXISTS measurements (
    id             UUID PRIMARY KEY,
    borehole_id    UUID NOT NULL REFERENCES boreholes(id) ON DELETE CASCADE,
    measured_at    TIMESTAMPTZ NOT NULL,
    probe_code     TEXT NOT NULL,
    datum_reset    BOOLEAN NOT NULL DEFAULT FALSE,
    datum_reason   TEXT NOT NULL DEFAULT 'initial',
    revision       INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (borehole_id, measured_at)
);
CREATE INDEX IF NOT EXISTS idx_measurements_bh_time ON measurements(borehole_id, measured_at);

CREATE TABLE IF NOT EXISTS measurement_readings (
    id                  UUID PRIMARY KEY,
    measurement_id      UUID NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
    ord                 INTEGER NOT NULL,
    depth               DOUBLE PRECISION NOT NULL CHECK (depth > 0),
    forward             DOUBLE PRECISION NOT NULL,
    reverse             DOUBLE PRECISION NOT NULL,
    probe_code_forward  TEXT NOT NULL,
    probe_code_reverse  TEXT NOT NULL,
    UNIQUE (measurement_id, depth)
);
CREATE INDEX IF NOT EXISTS idx_readings_measurement ON measurement_readings(measurement_id, ord);

-- 历史计算结果快照。同一测量内容（content_hash）不变时不新增行，
-- 因此“按当时数据判几级”的查询随时间稳定。
CREATE TABLE IF NOT EXISTS computed_snapshots (
    id                   UUID PRIMARY KEY,
    measurement_id       UUID NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
    content_hash         TEXT NOT NULL,
    revision_at_compute  INTEGER NOT NULL,
    result_json          JSONB NOT NULL,
    computed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (measurement_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_measurement_time
    ON computed_snapshots(measurement_id, computed_at);
