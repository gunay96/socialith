-- Phase 5C (rendering). One new table (media_render_jobs) and two new columns on media_assets (origin, render_job_id),
-- both with safe defaults, so every existing row stays valid and nothing existing is changed or dropped.

-- AlterTable
ALTER TABLE `media_assets` ADD COLUMN `origin` ENUM('UPLOAD', 'RENDER') NOT NULL DEFAULT 'UPLOAD',
    ADD COLUMN `render_job_id` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `media_render_jobs` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `source_asset_id` VARCHAR(191) NOT NULL,
    `source_sha256` VARCHAR(64) NOT NULL,
    `text_id` VARCHAR(191) NOT NULL,
    `text_snapshot` TEXT NOT NULL,
    `text_language` VARCHAR(16) NULL,
    `recipe_id` VARCHAR(191) NOT NULL,
    `recipe_name` VARCHAR(191) NOT NULL,
    `recipe_version` INTEGER NOT NULL,
    `page_id` VARCHAR(191) NULL,
    `page_group_id` VARCHAR(191) NULL,
    `campaign_id` VARCHAR(191) NULL,
    `recipe_config` JSON NOT NULL,
    `adjustment` JSON NULL,
    `effective` JSON NOT NULL,
    `dedupe_key` VARCHAR(64) NOT NULL,
    `active_key` VARCHAR(64) NULL,
    `retry_of_id` VARCHAR(191) NULL,
    `task_id` VARCHAR(191) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `cancel_requested_at` DATETIME(3) NULL,
    `output_asset_id` VARCHAR(191) NULL,
    `output_kind` VARCHAR(16) NULL,
    `result` JSON NULL,
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `error_remedy` TEXT NULL,
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,

    INDEX `media_render_jobs_organization_id_status_created_at_idx`(`organization_id`, `status`, `created_at`),
    INDEX `media_render_jobs_organization_id_dedupe_key_idx`(`organization_id`, `dedupe_key`),
    INDEX `media_render_jobs_source_asset_id_idx`(`source_asset_id`),
    INDEX `media_render_jobs_page_id_idx`(`page_id`),
    UNIQUE INDEX `media_render_jobs_organization_id_active_key_key`(`organization_id`, `active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `media_assets_render_job_id_key` ON `media_assets`(`render_job_id`);

-- AddForeignKey
ALTER TABLE `media_render_jobs` ADD CONSTRAINT `media_render_jobs_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
