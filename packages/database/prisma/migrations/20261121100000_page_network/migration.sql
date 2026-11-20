-- Phase 4 (Page Network). Purely additive: ten new nullable columns on managed_pages (a Phase 2 row stays valid and simply
-- reads as an incomplete page profile), five new tables, indexes and foreign keys. No existing column, enum value, index or
-- row is altered or removed; social_accounts, upload_post_* and campaigns are not touched at all.

-- AlterTable
ALTER TABLE `managed_pages` ADD COLUMN `category_id` VARCHAR(191) NULL,
    ADD COLUMN `editorial_identity` TEXT NULL,
    ADD COLUMN `internal_notes` TEXT NULL,
    ADD COLUMN `language` VARCHAR(16) NULL,
    ADD COLUMN `platform` ENUM('TIKTOK', 'INSTAGRAM', 'YOUTUBE') NULL,
    ADD COLUMN `profile` JSON NULL,
    ADD COLUMN `profile_url` TEXT NULL,
    ADD COLUMN `social_account_id` VARCHAR(191) NULL,
    ADD COLUMN `target_audience` TEXT NULL,
    ADD COLUMN `username` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `page_categories` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `language` VARCHAR(16) NOT NULL DEFAULT 'tr',
    `default_editorial_style` TEXT NULL,
    `content_preferences` JSON NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `page_categories_organization_id_status_idx`(`organization_id`, `status`),
    UNIQUE INDEX `page_categories_organization_id_slug_key`(`organization_id`, `slug`),
    UNIQUE INDEX `page_categories_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `page_groups` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `content_preferences` JSON NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `page_groups_organization_id_status_idx`(`organization_id`, `status`),
    UNIQUE INDEX `page_groups_organization_id_slug_key`(`organization_id`, `slug`),
    UNIQUE INDEX `page_groups_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `page_group_members` (
    `id` VARCHAR(191) NOT NULL,
    `group_id` VARCHAR(191) NOT NULL,
    `page_id` VARCHAR(191) NOT NULL,
    `added_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `page_group_members_page_id_idx`(`page_id`),
    UNIQUE INDEX `page_group_members_group_id_page_id_key`(`group_id`, `page_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaign_pages` (
    `id` VARCHAR(191) NOT NULL,
    `campaign_id` VARCHAR(191) NOT NULL,
    `page_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `campaign_pages_page_id_idx`(`page_id`),
    UNIQUE INDEX `campaign_pages_campaign_id_page_id_key`(`campaign_id`, `page_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaign_page_groups` (
    `id` VARCHAR(191) NOT NULL,
    `campaign_id` VARCHAR(191) NOT NULL,
    `group_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `campaign_page_groups_group_id_idx`(`group_id`),
    UNIQUE INDEX `campaign_page_groups_campaign_id_group_id_key`(`campaign_id`, `group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `managed_pages_social_account_id_key` ON `managed_pages`(`social_account_id`);

-- CreateIndex
CREATE INDEX `managed_pages_organization_id_category_id_idx` ON `managed_pages`(`organization_id`, `category_id`);

-- CreateIndex
CREATE INDEX `managed_pages_organization_id_platform_idx` ON `managed_pages`(`organization_id`, `platform`);

-- CreateIndex
CREATE UNIQUE INDEX `managed_pages_organization_id_platform_username_key` ON `managed_pages`(`organization_id`, `platform`, `username`);

-- AddForeignKey
ALTER TABLE `managed_pages` ADD CONSTRAINT `managed_pages_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `page_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_pages` ADD CONSTRAINT `managed_pages_social_account_id_fkey` FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `page_categories` ADD CONSTRAINT `page_categories_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `page_groups` ADD CONSTRAINT `page_groups_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `page_group_members` ADD CONSTRAINT `page_group_members_group_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `page_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `page_group_members` ADD CONSTRAINT `page_group_members_page_id_fkey` FOREIGN KEY (`page_id`) REFERENCES `managed_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_pages` ADD CONSTRAINT `campaign_pages_campaign_id_fkey` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_pages` ADD CONSTRAINT `campaign_pages_page_id_fkey` FOREIGN KEY (`page_id`) REFERENCES `managed_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_page_groups` ADD CONSTRAINT `campaign_page_groups_campaign_id_fkey` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_page_groups` ADD CONSTRAINT `campaign_page_groups_group_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `page_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
