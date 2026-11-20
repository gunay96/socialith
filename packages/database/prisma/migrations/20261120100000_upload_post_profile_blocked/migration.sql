-- Additive: the provider reports a per-profile `blocked` flag (observed live 2026-11-20).
-- A blocked profile is never used for publishing. Existing rows default to not blocked.
ALTER TABLE `upload_post_profiles` ADD COLUMN `blocked` BOOLEAN NOT NULL DEFAULT false;
