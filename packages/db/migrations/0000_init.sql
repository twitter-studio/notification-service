CREATE TABLE `delivery_dedup` (
	`account_id` text NOT NULL,
	`event_id` text NOT NULL,
	`accepted_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`account_id`, `event_id`)
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
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "devices_apns_environment" CHECK("devices"."apns_environment" IN ('sandbox', 'production'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token` ON `devices` (`token_fingerprint`,`apns_environment`,`topic`);--> statement-breakpoint
CREATE INDEX `idx_devices_installation` ON `devices` (`installation_id`);--> statement-breakpoint
CREATE TABLE `installations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`public_key` text NOT NULL,
	`attestation_state` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `notification_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_installations_account` ON `installations` (`account_id`);--> statement-breakpoint
CREATE TABLE `notification_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	CONSTRAINT "notification_accounts_state" CHECK("notification_accounts"."state" IN ('active', 'disabled', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `relay_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`last_used_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `notification_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_credentials_secret_hash_unique` ON `relay_credentials` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `idx_relay_credentials_account` ON `relay_credentials` (`account_id`);