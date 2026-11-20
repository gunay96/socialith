-- Phase 5A (Media Pack manager + progress ledger). Purely additive: nine new tables (media_packs, media_assets,
-- media_derivatives, media_asset_tags, four campaign / page-group assignment tables, operation_tasks) and foreign keys
-- that live on those new tables. No existing table, column, enum, index or row is touched.

-- CreateTable
CREATE TABLE `media_packs` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `source_type` ENUM('ZIP', 'MANUAL') NOT NULL DEFAULT 'ZIP',
    `source_file_name` VARCHAR(191) NULL,
    `source_archive_key` VARCHAR(512) NULL,
    `source_archive_bytes` BIGINT NULL,
    `source_archive_sha256` VARCHAR(64) NULL,
    `status` ENUM('PROCESSING', 'READY', 'PARTIAL', 'FAILED', 'ARCHIVED') NOT NULL DEFAULT 'PROCESSING',
    `entry_count` INTEGER NULL,
    `asset_count` INTEGER NOT NULL DEFAULT 0,
    `rejected_count` INTEGER NOT NULL DEFAULT 0,
    `duplicate_count` INTEGER NOT NULL DEFAULT 0,
    `ignored_count` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `completed_at` DATETIME(3) NULL,

    INDEX `media_packs_organization_id_status_idx`(`organization_id`, `status`),
    INDEX `media_packs_organization_id_created_at_idx`(`organization_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_assets` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `pack_id` VARCHAR(191) NULL,
    `folder_path` VARCHAR(255) NOT NULL DEFAULT '',
    `original_name` VARCHAR(191) NOT NULL,
    `entry_path` VARCHAR(255) NULL,
    `kind` ENUM('VIDEO', 'IMAGE', 'AUDIO', 'TEXT', 'SPREADSHEET') NOT NULL,
    `status` ENUM('ANALYZING', 'READY', 'FAILED', 'REJECTED', 'DUPLICATE', 'ARCHIVED') NOT NULL DEFAULT 'ANALYZING',
    `mime_type` VARCHAR(100) NOT NULL,
    `size_bytes` BIGINT NOT NULL,
    `sha256` VARCHAR(64) NOT NULL,
    `storage_key` VARCHAR(512) NULL,
    `duplicate_of_id` VARCHAR(191) NULL,
    `rejection_code` VARCHAR(64) NULL,
    `rejection_reason` TEXT NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `aspect_ratio` VARCHAR(16) NULL,
    `aspect_decimal` DOUBLE NULL,
    `duration_ms` INTEGER NULL,
    `fps` DOUBLE NULL,
    `video_codec` VARCHAR(40) NULL,
    `audio_codec` VARCHAR(40) NULL,
    `has_audio` BOOLEAN NULL,
    `bitrate_kbps` INTEGER NULL,
    `container` VARCHAR(80) NULL,
    `sample_rate` INTEGER NULL,
    `channels` INTEGER NULL,
    `facts` JSON NULL,
    `rights_status` ENUM('UNVERIFIED', 'CONFIRMED', 'RESTRICTED') NOT NULL DEFAULT 'UNVERIFIED',
    `rights_notes` TEXT NULL,
    `rights_confirmed_by_id` VARCHAR(191) NULL,
    `rights_confirmed_at` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `analyzed_at` DATETIME(3) NULL,

    INDEX `media_assets_organization_id_sha256_idx`(`organization_id`, `sha256`),
    INDEX `media_assets_organization_id_status_kind_idx`(`organization_id`, `status`, `kind`),
    INDEX `media_assets_organization_id_created_at_idx`(`organization_id`, `created_at`),
    INDEX `media_assets_organization_id_original_name_idx`(`organization_id`, `original_name`),
    INDEX `media_assets_pack_id_idx`(`pack_id`),
    UNIQUE INDEX `media_assets_pack_id_entry_path_key`(`pack_id`, `entry_path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_derivatives` (
    `id` VARCHAR(191) NOT NULL,
    `asset_id` VARCHAR(191) NOT NULL,
    `kind` ENUM('THUMBNAIL', 'PREVIEW') NOT NULL,
    `storage_key` VARCHAR(512) NOT NULL,
    `content_type` VARCHAR(100) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `duration_ms` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `media_derivatives_asset_id_kind_key`(`asset_id`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_asset_tags` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `asset_id` VARCHAR(191) NOT NULL,
    `tag` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `media_asset_tags_organization_id_tag_idx`(`organization_id`, `tag`),
    UNIQUE INDEX `media_asset_tags_asset_id_tag_key`(`asset_id`, `tag`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_pack_campaigns` (
    `id` VARCHAR(191) NOT NULL,
    `pack_id` VARCHAR(191) NOT NULL,
    `campaign_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `media_pack_campaigns_campaign_id_idx`(`campaign_id`),
    UNIQUE INDEX `media_pack_campaigns_pack_id_campaign_id_key`(`pack_id`, `campaign_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_pack_page_groups` (
    `id` VARCHAR(191) NOT NULL,
    `pack_id` VARCHAR(191) NOT NULL,
    `group_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `media_pack_page_groups_group_id_idx`(`group_id`),
    UNIQUE INDEX `media_pack_page_groups_pack_id_group_id_key`(`pack_id`, `group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_asset_campaigns` (
    `id` VARCHAR(191) NOT NULL,
    `asset_id` VARCHAR(191) NOT NULL,
    `campaign_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `media_asset_campaigns_campaign_id_idx`(`campaign_id`),
    UNIQUE INDEX `media_asset_campaigns_asset_id_campaign_id_key`(`asset_id`, `campaign_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_asset_page_groups` (
    `id` VARCHAR(191) NOT NULL,
    `asset_id` VARCHAR(191) NOT NULL,
    `group_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `media_asset_page_groups_group_id_idx`(`group_id`),
    UNIQUE INDEX `media_asset_page_groups_asset_id_group_id_key`(`asset_id`, `group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `operation_tasks` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(40) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `stage` VARCHAR(80) NULL,
    `stage_detail` VARCHAR(255) NULL,
    `completed_units` INTEGER NOT NULL DEFAULT 0,
    `total_units` INTEGER NULL,
    `unit` VARCHAR(24) NULL,
    `subject_type` VARCHAR(40) NULL,
    `subject_id` VARCHAR(191) NULL,
    `parent_task_id` VARCHAR(191) NULL,
    `queue_name` VARCHAR(64) NULL,
    `queue_job_id` VARCHAR(128) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `error_remedy` TEXT NULL,
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `last_progress_at` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `operation_tasks_organization_id_status_created_at_idx`(`organization_id`, `status`, `created_at`),
    INDEX `operation_tasks_organization_id_type_created_at_idx`(`organization_id`, `type`, `created_at`),
    INDEX `operation_tasks_subject_type_subject_id_idx`(`subject_type`, `subject_id`),
    INDEX `operation_tasks_parent_task_id_idx`(`parent_task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `media_packs` ADD CONSTRAINT `media_packs_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_assets` ADD CONSTRAINT `media_assets_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_assets` ADD CONSTRAINT `media_assets_pack_id_fkey` FOREIGN KEY (`pack_id`) REFERENCES `media_packs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_assets` ADD CONSTRAINT `media_assets_duplicate_of_id_fkey` FOREIGN KEY (`duplicate_of_id`) REFERENCES `media_assets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_derivatives` ADD CONSTRAINT `media_derivatives_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_asset_tags` ADD CONSTRAINT `media_asset_tags_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_pack_campaigns` ADD CONSTRAINT `media_pack_campaigns_pack_id_fkey` FOREIGN KEY (`pack_id`) REFERENCES `media_packs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_pack_campaigns` ADD CONSTRAINT `media_pack_campaigns_campaign_id_fkey` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_pack_page_groups` ADD CONSTRAINT `media_pack_page_groups_pack_id_fkey` FOREIGN KEY (`pack_id`) REFERENCES `media_packs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_pack_page_groups` ADD CONSTRAINT `media_pack_page_groups_group_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `page_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_asset_campaigns` ADD CONSTRAINT `media_asset_campaigns_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_asset_campaigns` ADD CONSTRAINT `media_asset_campaigns_campaign_id_fkey` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_asset_page_groups` ADD CONSTRAINT `media_asset_page_groups_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_asset_page_groups` ADD CONSTRAINT `media_asset_page_groups_group_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `page_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `operation_tasks` ADD CONSTRAINT `operation_tasks_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
