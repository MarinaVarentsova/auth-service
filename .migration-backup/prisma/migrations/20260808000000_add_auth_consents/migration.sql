-- Migration: add_auth_consents
-- Created: 2026-08-08
-- NOTE: production table was created manually. This file is for version control only.
-- DO NOT run this against production.

CREATE TABLE IF NOT EXISTS auth_consents (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  email           TEXT         NOT NULL,
  document_type   VARCHAR(50)  NOT NULL,
  document_version VARCHAR(20) NOT NULL DEFAULT '1.0',
  accepted        BOOLEAN      NOT NULL,
  accepted_at     TIMESTAMPTZ  NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_consents_user_type
  ON auth_consents(user_id, document_type);
