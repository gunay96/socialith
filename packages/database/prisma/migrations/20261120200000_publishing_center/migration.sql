-- Phase 3 (Publishing Center). Purely additive: new nullable/defaulted columns on campaigns and content_targets,
-- three new tables (publication_events, content_revisions, publishing_settings) and one index.
-- No existing column, enum value or row is altered; existing content_targets get approval_status = DRAFT.

-- AlterTable
ALTER TABLE `campaigns` ADD COLUMN `auto_schedule_on_approval` BOOLEAN NULL;

-- AlterTable
ALTER TABLE `content_targets` ADD COLUMN `approval_status` ENUM('DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN `approved_at` DATETIME(3) NULL,
    ADD COLUMN `approved_by_id` VARCHAR(191) NULL,
    ADD COLUMN `approved_payload` TEXT NULL,
    ADD COLUMN `caption_override` TEXT NULL,
    ADD COLUMN `exception` ENUM('HELD', 'CANCELLED', 'STALE') NULL,
    ADD COLUMN `require_music` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `scheduled_timezone` VARCHAR(64) NULL,
    ADD COLUMN `submitted_at` DATETIME(3) NULL,
    ADD COLUMN `submitted_by_id` VARCHAR(191) NULL,
    ADD COLUMN `title_override` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `publication_events` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `content_target_id` VARCHAR(191) NOT NULL,
    `type` ENUM('CREATED', 'EDITED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'INVALIDATED', 'SCHEDULED', 'AUTO_SCHEDULED', 'RESCHEDULED', 'UNSCHEDULED', 'HELD', 'RELEASED', 'CANCELLED', 'REOPENED', 'RETRIED', 'MARKED_STALE') NOT NULL,
    `from_state` VARCHAR(32) NULL,
    `to_state` VARCHAR(32) NULL,
    `actor_id` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `publication_events_content_target_id_created_at_idx`(`content_target_id`, `created_at`),
    INDEX `publication_events_organization_id_created_at_idx`(`organization_id`, `created_at`),
    INDEX `publication_events_organization_id_type_created_at_idx`(`organization_id`, `type`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_revisions` (
    `id` VARCHAR(191) NOT NULL,
    `content_id` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `snapshot` JSON NOT NULL,
    `reason` VARCHAR(255) NULL,
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `content_revisions_content_id_revision_key`(`content_id`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publishing_settings` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'Europe/Istanbul',
    `require_approval` BOOLEAN NOT NULL DEFAULT true,
    `allow_self_approval` BOOLEAN NOT NULL DEFAULT true,
    `auto_schedule_on_approval` BOOLEAN NOT NULL DEFAULT false,
    `duplicate_guard` ENUM('BLOCK', 'WARN', 'OFF') NOT NULL DEFAULT 'BLOCK',
    `similarity_threshold_pct` INTEGER NOT NULL DEFAULT 85,
    `max_similar_per_platform` INTEGER NOT NULL DEFAULT 1,
    `max_posts_per_destination_per_day` INTEGER NOT NULL DEFAULT 3,
    `min_minutes_between_posts` INTEGER NOT NULL DEFAULT 60,
    `min_lead_minutes` INTEGER NOT NULL DEFAULT 10,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `publishing_settings_organization_id_key`(`organization_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `content_targets_approval_status_status_idx` ON `content_targets`(`approval_status`, `status`);

-- AddForeignKey
ALTER TABLE `publication_events` ADD CONSTRAINT `publication_events_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_events` ADD CONSTRAINT `publication_events_content_target_id_fkey` FOREIGN KEY (`content_target_id`) REFERENCES `content_targets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_events` ADD CONSTRAINT `publication_events_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_revisions` ADD CONSTRAINT `content_revisions_content_id_fkey` FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_revisions` ADD CONSTRAINT `content_revisions_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publishing_settings` ADD CONSTRAINT `publishing_settings_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

