CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`username` text,
	`email` text,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`credential_ref` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_id` text NOT NULL,
	`original_filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`kind` text NOT NULL,
	`data_base64` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_inbound_events` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_id` text NOT NULL,
	`source_channel` text NOT NULL,
	`external_chat_id` text NOT NULL,
	`external_message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversation_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_id` text NOT NULL,
	`conversation_key` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`total_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_output_tokens` integer DEFAULT 0 NOT NULL,
	`total_estimated_cost` real DEFAULT 0 NOT NULL,
	`context_summary` text,
	`context_compacted_message_count` integer DEFAULT 0 NOT NULL,
	`context_compacted_at` integer
);
--> statement-breakpoint
CREATE TABLE `cron_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cron_expression` text NOT NULL,
	`timezone` text,
	`message` text NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cron_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`output` text,
	`error` text,
	`conversation_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `cron_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `llm_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`assistant_id` text,
	`conversation_id` text,
	`run_id` text,
	`request_id` text,
	`actor` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_creation_input_tokens` integer,
	`cache_read_input_tokens` integer,
	`estimated_cost_usd` real,
	`pricing_status` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE `memory_checkpoints` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`vector_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`aliases` text,
	`description` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`mention_count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_entity_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_entity_id` text NOT NULL,
	`target_entity_id` text NOT NULL,
	`relation` text NOT NULL,
	`evidence` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_item_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text DEFAULT 'default' NOT NULL,
	`existing_item_id` text NOT NULL,
	`candidate_item_id` text NOT NULL,
	`relationship` text NOT NULL,
	`status` text NOT NULL,
	`clarification_question` text,
	`resolution_note` text,
	`last_asked_at` integer,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`existing_item_id`) REFERENCES `memory_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_item_id`) REFERENCES `memory_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memory_item_entities` (
	`memory_item_id` text NOT NULL,
	`entity_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_item_sources` (
	`memory_item_id` text NOT NULL,
	`message_id` text NOT NULL,
	`evidence` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memory_item_id`) REFERENCES `memory_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`statement` text NOT NULL,
	`status` text NOT NULL,
	`confidence` real NOT NULL,
	`importance` real,
	`access_count` integer DEFAULT 0 NOT NULL,
	`fingerprint` text NOT NULL,
	`verification_state` text DEFAULT 'assistant_inferred' NOT NULL,
	`scope_id` text DEFAULT 'default' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_used_at` integer,
	`valid_from` integer,
	`invalid_at` integer
);
--> statement-breakpoint
CREATE TABLE `memory_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`deferrals` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`segment_index` integer NOT NULL,
	`text` text NOT NULL,
	`token_estimate` integer NOT NULL,
	`scope_id` text DEFAULT 'default' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memory_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_key` text NOT NULL,
	`summary` text NOT NULL,
	`token_estimate` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`scope_id` text DEFAULT 'default' NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `message_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`pending_confirmation` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost` real DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `shared_app_links` (
	`id` text PRIMARY KEY NOT NULL,
	`share_token` text NOT NULL,
	`bundle_data` blob NOT NULL,
	`bundle_size_bytes` integer NOT NULL,
	`manifest_json` text NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_app_links_share_token_unique` ON `shared_app_links` (`share_token`);--> statement-breakpoint
CREATE TABLE `tool_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input` text NOT NULL,
	`result` text NOT NULL,
	`decision` text NOT NULL,
	`risk_level` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
