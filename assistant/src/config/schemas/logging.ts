import { z } from "zod";

export const AuditLogConfigSchema = z.object({
  retentionDays: z
    .number({ error: "auditLog.retentionDays must be a number" })
    .int("auditLog.retentionDays must be an integer")
    .nonnegative("auditLog.retentionDays must be a non-negative integer")
    .default(0),
});

export const LogFileConfigSchema = z.object({
  dir: z.string({ error: "logFile.dir must be a string" }).optional(),
  retentionDays: z
    .number({ error: "logFile.retentionDays must be a number" })
    .int("logFile.retentionDays must be an integer")
    .positive("logFile.retentionDays must be a positive integer")
    .default(30),
});

export type AuditLogConfig = z.infer<typeof AuditLogConfigSchema>;
export type LogFileConfig = z.infer<typeof LogFileConfigSchema>;
