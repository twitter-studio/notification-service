CREATE TABLE `installation_attestations` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`app_id` text NOT NULL,
	`environment` text NOT NULL,
	`receipt_ciphertext` text NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attestations_counter" CHECK("installation_attestations"."counter" BETWEEN 0 AND 4294967295),
	CONSTRAINT "attestations_environment" CHECK("installation_attestations"."environment" IN ('development', 'production')),
	CONSTRAINT "attestations_receipt_ciphertext" CHECK("installation_attestations"."receipt_ciphertext" GLOB 'ar1.*'),
	CONSTRAINT "attestations_key_id" CHECK(length("installation_attestations"."key_id") = 43 AND "installation_attestations"."key_id" NOT GLOB '*[^A-Za-z0-9_-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installation_attestations_key_id_unique` ON `installation_attestations` (`key_id`);