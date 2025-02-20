ALTER TABLE `users` ADD `encryption_key` text;--> statement-breakpoint
ALTER TABLE `user_settings` DROP COLUMN `encryption_key`;