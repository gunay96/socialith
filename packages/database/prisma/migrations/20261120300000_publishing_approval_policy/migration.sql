-- Phase 3 final product decision: self-approval policy per role.
-- The owner may approve their own submission (new column, default on); an admin only when allowed (existing column allow_self_approval,
-- default now OFF). Only a default changes: no existing row is touched, so a preference somebody saved is preserved.
ALTER TABLE `publishing_settings` ADD COLUMN `owner_self_approval` BOOLEAN NOT NULL DEFAULT true,
    MODIFY `allow_self_approval` BOOLEAN NOT NULL DEFAULT false;
