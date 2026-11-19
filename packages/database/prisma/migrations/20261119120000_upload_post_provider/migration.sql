-- AlterTable
ALTER TABLE `social_accounts` ADD COLUMN `publishing_provider` ENUM('NATIVE', 'UPLOAD_POST') NOT NULL DEFAULT 'NATIVE';

-- CreateTable
CREATE TABLE `managed_pages` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `managed_pages_organization_id_status_idx`(`organization_id`, `status`),
    UNIQUE INDEX `managed_pages_organization_id_slug_key`(`organization_id`, `slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `creators` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `creators_organization_id_status_idx`(`organization_id`, `status`),
    UNIQUE INDEX `creators_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `upload_post_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `provider_created_at` DATETIME(3) NULL,
    `status` ENUM('ACTIVE', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
    `pending_platforms` JSON NULL,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_synced_at` DATETIME(3) NULL,
    `removed_at` DATETIME(3) NULL,
    `managed_page_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `upload_post_profiles_organization_id_status_idx`(`organization_id`, `status`),
    INDEX `upload_post_profiles_managed_page_id_idx`(`managed_page_id`),
    UNIQUE INDEX `upload_post_profiles_organization_id_username_key`(`organization_id`, `username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `upload_post_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `profile_id` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `provider_account_id` VARCHAR(191) NOT NULL,
    `handle` VARCHAR(191) NULL,
    `display_name` VARCHAR(191) NULL,
    `avatar_url` TEXT NULL,
    `status` ENUM('CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED') NOT NULL DEFAULT 'CONNECTED',
    `reauth_required` BOOLEAN NOT NULL DEFAULT false,
    `capabilities` JSON NULL,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NULL,
    `disconnected_at` DATETIME(3) NULL,
    `creator_id` VARCHAR(191) NULL,
    `social_account_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `upload_post_accounts_social_account_id_key`(`social_account_id`),
    INDEX `upload_post_accounts_organization_id_platform_status_idx`(`organization_id`, `platform`, `status`),
    INDEX `upload_post_accounts_organization_id_platform_provider_accou_idx`(`organization_id`, `platform`, `provider_account_id`),
    INDEX `upload_post_accounts_creator_id_idx`(`creator_id`),
    UNIQUE INDEX `upload_post_accounts_profile_id_platform_key`(`profile_id`, `platform`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `upload_post_sync_runs` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `trigger` VARCHAR(191) NOT NULL,
    `status` ENUM('RUNNING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `profiles_seen` INTEGER NOT NULL DEFAULT 0,
    `profiles_created` INTEGER NOT NULL DEFAULT 0,
    `profiles_updated` INTEGER NOT NULL DEFAULT 0,
    `profiles_removed` INTEGER NOT NULL DEFAULT 0,
    `accounts_seen` INTEGER NOT NULL DEFAULT 0,
    `accounts_created` INTEGER NOT NULL DEFAULT 0,
    `accounts_updated` INTEGER NOT NULL DEFAULT 0,
    `accounts_disconnected` INTEGER NOT NULL DEFAULT 0,
    `accounts_reauth` INTEGER NOT NULL DEFAULT 0,
    `plan` VARCHAR(191) NULL,
    `profile_limit` INTEGER NULL,
    `error_kind` VARCHAR(191) NULL,
    `error_message` TEXT NULL,

    INDEX `upload_post_sync_runs_organization_id_started_at_idx`(`organization_id`, `started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `upload_post_publications` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `content_target_id` VARCHAR(191) NOT NULL,
    `mode` ENUM('IMMEDIATE', 'PROVIDER_SCHEDULED') NOT NULL DEFAULT 'IMMEDIATE',
    `status` ENUM('PENDING', 'PROCESSING', 'SCHEDULED_AT_PROVIDER', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN_OUTCOME') NOT NULL DEFAULT 'PENDING',
    `generation` INTEGER NOT NULL DEFAULT 1,
    `external_id` VARCHAR(191) NOT NULL,
    `request_id` VARCHAR(191) NOT NULL,
    `idempotency_key` VARCHAR(191) NOT NULL,
    `profile_username` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `provider_job_id` VARCHAR(191) NULL,
    `scheduled_for` DATETIME(3) NULL,
    `handed_off_at` DATETIME(3) NULL,
    `tiktok_music_id` VARCHAR(191) NULL,
    `last_provider_status` VARCHAR(191) NULL,
    `last_provider_result` JSON NULL,
    `last_synced_at` DATETIME(3) NULL,
    `last_error_kind` VARCHAR(191) NULL,
    `last_error_message` TEXT NULL,
    `submitted_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `upload_post_publications_content_target_id_key`(`content_target_id`),
    UNIQUE INDEX `upload_post_publications_external_id_key`(`external_id`),
    UNIQUE INDEX `upload_post_publications_request_id_key`(`request_id`),
    INDEX `upload_post_publications_status_last_synced_at_idx`(`status`, `last_synced_at`),
    INDEX `upload_post_publications_organization_id_status_idx`(`organization_id`, `status`),
    INDEX `upload_post_publications_provider_job_id_idx`(`provider_job_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `upload_post_webhook_deliveries` (
    `id` VARCHAR(191) NOT NULL,
    `delivery_id` VARCHAR(191) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `attempt` INTEGER NULL,
    `request_id` VARCHAR(191) NULL,
    `job_id` VARCHAR(191) NULL,
    `external_id` VARCHAR(191) NULL,
    `outcome` VARCHAR(191) NOT NULL,
    `detail` TEXT NULL,
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) NULL,

    UNIQUE INDEX `upload_post_webhook_deliveries_delivery_id_key`(`delivery_id`),
    INDEX `upload_post_webhook_deliveries_received_at_idx`(`received_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sound_music_mappings` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `sound_id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'UPLOAD_POST_TIKTOK',
    `provider_music_id` VARCHAR(191) NOT NULL,
    `commercial_music_id` VARCHAR(191) NULL,
    `provider_title` VARCHAR(191) NOT NULL,
    `provider_artist` VARCHAR(191) NULL,
    `duration_sec` INTEGER NULL,
    `preview_url` TEXT NULL,
    `cover_url` TEXT NULL,
    `availability` ENUM('UNVERIFIED', 'VERIFIED_AVAILABLE', 'UNAVAILABLE') NOT NULL DEFAULT 'UNVERIFIED',
    `verified_at` DATETIME(3) NULL,
    `verified_with_profile` VARCHAR(191) NULL,
    `rights_confirmed` BOOLEAN NOT NULL DEFAULT false,
    `rights_confirmed_at` DATETIME(3) NULL,
    `rights_confirmed_by_id` VARCHAR(191) NULL,
    `rights_note` TEXT NULL,
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `sound_music_mappings_organization_id_sound_id_idx`(`organization_id`, `sound_id`),
    INDEX `sound_music_mappings_organization_id_availability_idx`(`organization_id`, `availability`),
    UNIQUE INDEX `sound_music_mappings_sound_id_provider_provider_music_id_key`(`sound_id`, `provider`, `provider_music_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `managed_pages` ADD CONSTRAINT `managed_pages_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `creators` ADD CONSTRAINT `creators_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_post_profiles` ADD CONSTRAINT `upload_post_profiles_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_post_profiles` ADD CONSTRAINT `upload_post_profiles_managed_page_id_fkey` FOREIGN KEY (`managed_page_id`) REFERENCES `managed_pages`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_post_accounts` ADD CONSTRAINT `upload_post_accounts_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_post_accounts` ADD CONSTRAINT `upload_post_accounts_profile_id_fkey` FOREIGN KEY (`profile_id`) REFERENCES `upload_post_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_post_accounts` ADD CONSTRAINT `upload_post_accounts_creator_id_fkey` FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_post_accounts` ADD CONSTRAINT `upload_post_accounts_social_account_id_fkey` FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_post_sync_runs` ADD CONSTRAINT `upload_post_sync_runs_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_post_publications` ADD CONSTRAINT `upload_post_publications_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_post_publications` ADD CONSTRAINT `upload_post_publications_content_target_id_fkey` FOREIGN KEY (`content_target_id`) REFERENCES `content_targets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sound_music_mappings` ADD CONSTRAINT `sound_music_mappings_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sound_music_mappings` ADD CONSTRAINT `sound_music_mappings_sound_id_fkey` FOREIGN KEY (`sound_id`) REFERENCES `sounds`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
