-- CreateTable
CREATE TABLE `text_categories` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `text_categories_organization_id_status_idx`(`organization_id`, `status`),
    UNIQUE INDEX `text_categories_organization_id_slug_key`(`organization_id`, `slug`),
    UNIQUE INDEX `text_categories_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_import_batches` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `file_name` VARCHAR(191) NOT NULL,
    `format` ENUM('MANUAL', 'TXT', 'CSV', 'XLSX') NOT NULL,
    `file_bytes` INTEGER NOT NULL,
    `content_sha256` VARCHAR(64) NOT NULL,
    `total_rows` INTEGER NOT NULL,
    `imported_count` INTEGER NOT NULL,
    `duplicate_count` INTEGER NOT NULL,
    `invalid_count` INTEGER NOT NULL,
    `options` JSON NULL,
    `problems` JSON NULL,
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `text_import_batches_organization_id_created_at_idx`(`organization_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_entries` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `normalized_hash` VARCHAR(64) NOT NULL,
    `search_text` TEXT NOT NULL,
    `char_count` INTEGER NOT NULL,
    `language` VARCHAR(16) NULL,
    `source` ENUM('MANUAL', 'TXT', 'CSV', 'XLSX') NOT NULL DEFAULT 'MANUAL',
    `source_note` VARCHAR(255) NULL,
    `source_row` INTEGER NULL,
    `import_batch_id` VARCHAR(191) NULL,
    `author` VARCHAR(255) NULL,
    `rights_status` ENUM('UNVERIFIED', 'CONFIRMED', 'RESTRICTED') NOT NULL DEFAULT 'UNVERIFIED',
    `rights_notes` TEXT NULL,
    `approval_status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'ARCHIVED') NOT NULL DEFAULT 'PENDING',
    `approved_by_id` VARCHAR(191) NULL,
    `approved_at` DATETIME(3) NULL,
    `review_note` TEXT NULL,
    `notes` TEXT NULL,
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `text_entries_organization_id_approval_status_created_at_idx`(`organization_id`, `approval_status`, `created_at`),
    INDEX `text_entries_organization_id_language_idx`(`organization_id`, `language`),
    INDEX `text_entries_organization_id_import_batch_id_idx`(`organization_id`, `import_batch_id`),
    UNIQUE INDEX `text_entries_organization_id_normalized_hash_key`(`organization_id`, `normalized_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_entry_categories` (
    `id` VARCHAR(191) NOT NULL,
    `text_id` VARCHAR(191) NOT NULL,
    `category_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `text_entry_categories_category_id_idx`(`category_id`),
    UNIQUE INDEX `text_entry_categories_text_id_category_id_key`(`text_id`, `category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_entry_campaigns` (
    `id` VARCHAR(191) NOT NULL,
    `text_id` VARCHAR(191) NOT NULL,
    `campaign_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `text_entry_campaigns_campaign_id_idx`(`campaign_id`),
    UNIQUE INDEX `text_entry_campaigns_text_id_campaign_id_key`(`text_id`, `campaign_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_entry_page_categories` (
    `id` VARCHAR(191) NOT NULL,
    `text_id` VARCHAR(191) NOT NULL,
    `category_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `text_entry_page_categories_category_id_idx`(`category_id`),
    UNIQUE INDEX `text_entry_page_categories_text_id_category_id_key`(`text_id`, `category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_entry_pages` (
    `id` VARCHAR(191) NOT NULL,
    `text_id` VARCHAR(191) NOT NULL,
    `page_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `text_entry_pages_page_id_idx`(`page_id`),
    UNIQUE INDEX `text_entry_pages_text_id_page_id_key`(`text_id`, `page_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_entry_page_groups` (
    `id` VARCHAR(191) NOT NULL,
    `text_id` VARCHAR(191) NOT NULL,
    `group_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `text_entry_page_groups_group_id_idx`(`group_id`),
    UNIQUE INDEX `text_entry_page_groups_text_id_group_id_key`(`text_id`, `group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_collections` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `text_collections_organization_id_status_idx`(`organization_id`, `status`),
    UNIQUE INDEX `text_collections_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_collection_items` (
    `id` VARCHAR(191) NOT NULL,
    `collection_id` VARCHAR(191) NOT NULL,
    `text_id` VARCHAR(191) NOT NULL,
    `added_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `text_collection_items_text_id_idx`(`text_id`),
    UNIQUE INDEX `text_collection_items_collection_id_text_id_key`(`collection_id`, `text_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `text_usages` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `text_id` VARCHAR(191) NOT NULL,
    `kind` ENUM('MANUAL', 'PUBLICATION', 'RENDER') NOT NULL,
    `used_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `note` VARCHAR(500) NULL,
    `page_id` VARCHAR(191) NULL,
    `campaign_id` VARCHAR(191) NULL,
    `recipe_id` VARCHAR(191) NULL,
    `media_asset_id` VARCHAR(191) NULL,
    `content_id` VARCHAR(191) NULL,
    `recorded_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `text_usages_text_id_used_at_idx`(`text_id`, `used_at`),
    INDEX `text_usages_organization_id_page_id_used_at_idx`(`organization_id`, `page_id`, `used_at`),
    INDEX `text_usages_content_id_idx`(`content_id`),
    INDEX `text_usages_recipe_id_idx`(`recipe_id`),
    INDEX `text_usages_media_asset_id_idx`(`media_asset_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_recipes` (
    `id` VARCHAR(191) NOT NULL,
    `organization_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `format_id` VARCHAR(64) NULL,
    `preset_key` VARCHAR(64) NULL,
    `config` JSON NOT NULL,
    `schema_version` INTEGER NOT NULL DEFAULT 1,
    `preview_config` JSON NULL,
    `required_text_category_id` VARCHAR(191) NULL,
    `duplicated_from_id` VARCHAR(191) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_by_id` VARCHAR(191) NULL,
    `updated_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `content_recipes_organization_id_status_idx`(`organization_id`, `status`),
    INDEX `content_recipes_organization_id_preset_key_idx`(`organization_id`, `preset_key`),
    INDEX `content_recipes_required_text_category_id_idx`(`required_text_category_id`),
    UNIQUE INDEX `content_recipes_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_recipe_page_categories` (
    `id` VARCHAR(191) NOT NULL,
    `recipe_id` VARCHAR(191) NOT NULL,
    `category_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `content_recipe_page_categories_category_id_idx`(`category_id`),
    UNIQUE INDEX `content_recipe_page_categories_recipe_id_category_id_key`(`recipe_id`, `category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_recipe_page_groups` (
    `id` VARCHAR(191) NOT NULL,
    `recipe_id` VARCHAR(191) NOT NULL,
    `group_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `content_recipe_page_groups_group_id_idx`(`group_id`),
    UNIQUE INDEX `content_recipe_page_groups_recipe_id_group_id_key`(`recipe_id`, `group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_recipe_pages` (
    `id` VARCHAR(191) NOT NULL,
    `recipe_id` VARCHAR(191) NOT NULL,
    `page_id` VARCHAR(191) NOT NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `content_recipe_pages_page_id_idx`(`page_id`),
    UNIQUE INDEX `content_recipe_pages_recipe_id_page_id_key`(`recipe_id`, `page_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `text_categories` ADD CONSTRAINT `text_categories_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_import_batches` ADD CONSTRAINT `text_import_batches_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entries` ADD CONSTRAINT `text_entries_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_categories` ADD CONSTRAINT `text_entry_categories_text_id_fkey` FOREIGN KEY (`text_id`) REFERENCES `text_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_categories` ADD CONSTRAINT `text_entry_categories_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `text_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_campaigns` ADD CONSTRAINT `text_entry_campaigns_text_id_fkey` FOREIGN KEY (`text_id`) REFERENCES `text_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_campaigns` ADD CONSTRAINT `text_entry_campaigns_campaign_id_fkey` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_page_categories` ADD CONSTRAINT `text_entry_page_categories_text_id_fkey` FOREIGN KEY (`text_id`) REFERENCES `text_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_page_categories` ADD CONSTRAINT `text_entry_page_categories_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `page_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_pages` ADD CONSTRAINT `text_entry_pages_text_id_fkey` FOREIGN KEY (`text_id`) REFERENCES `text_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_pages` ADD CONSTRAINT `text_entry_pages_page_id_fkey` FOREIGN KEY (`page_id`) REFERENCES `managed_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_page_groups` ADD CONSTRAINT `text_entry_page_groups_text_id_fkey` FOREIGN KEY (`text_id`) REFERENCES `text_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_entry_page_groups` ADD CONSTRAINT `text_entry_page_groups_group_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `page_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_collections` ADD CONSTRAINT `text_collections_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_collection_items` ADD CONSTRAINT `text_collection_items_collection_id_fkey` FOREIGN KEY (`collection_id`) REFERENCES `text_collections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_collection_items` ADD CONSTRAINT `text_collection_items_text_id_fkey` FOREIGN KEY (`text_id`) REFERENCES `text_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_usages` ADD CONSTRAINT `text_usages_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `text_usages` ADD CONSTRAINT `text_usages_text_id_fkey` FOREIGN KEY (`text_id`) REFERENCES `text_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_recipes` ADD CONSTRAINT `content_recipes_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_recipe_page_categories` ADD CONSTRAINT `content_recipe_page_categories_recipe_id_fkey` FOREIGN KEY (`recipe_id`) REFERENCES `content_recipes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_recipe_page_categories` ADD CONSTRAINT `content_recipe_page_categories_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `page_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_recipe_page_groups` ADD CONSTRAINT `content_recipe_page_groups_recipe_id_fkey` FOREIGN KEY (`recipe_id`) REFERENCES `content_recipes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_recipe_page_groups` ADD CONSTRAINT `content_recipe_page_groups_group_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `page_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_recipe_pages` ADD CONSTRAINT `content_recipe_pages_recipe_id_fkey` FOREIGN KEY (`recipe_id`) REFERENCES `content_recipes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_recipe_pages` ADD CONSTRAINT `content_recipe_pages_page_id_fkey` FOREIGN KEY (`page_id`) REFERENCES `managed_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
