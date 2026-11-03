CREATE TABLE `delivery_dedup` (
	`account_id` text NOT NULL,
	`event_id` text NOT NULL,
	`accepted_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	PRIMARY KEY(`account_id`, `event_id`),
	FOREIGN KEY (`account_id`) REFERENCES `notification_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_delivery_dedup_accepted` ON `delivery_dedup` (`accepted_at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`apns_token_ciphertext` text NOT NULL,
	`token_fingerprint` text NOT NULL,
	`apns_environment` text NOT NULL,
	`topic` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`verified_at` integer,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "devices_apns_environment" CHECK("devices"."apns_environment" IN ('sandbox', 'production')),
	CONSTRAINT "devices_state" CHECK("devices"."state" IN ('active', 'disabled_by_user', 'invalidated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_installation_id_unique` ON `devices` (`installation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token` ON `devices` (`token_fingerprint`,`apns_environment`,`topic`);--> statement-breakpoint
CREATE TABLE `installations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`public_key` text NOT NULL,
	`attestation_state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `notification_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "installations_attestation_state" CHECK("installations"."attestation_state" IN ('pending', 'verified', 'not_supported'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installations_public_key_unique` ON `installations` (`public_key`);--> statement-breakpoint
CREATE INDEX `idx_installations_account` ON `installations` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `installations_one_active_per_account` ON `installations` (`account_id`) WHERE "installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `notification_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "notification_accounts_state" CHECK("notification_accounts"."state" IN ('active', 'disabled', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `relay_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `notification_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_credentials_secret_hash_unique` ON `relay_credentials` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `idx_relay_credentials_account` ON `relay_credentials` (`account_id`);