import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 *
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config, workspace, and skills to R2
 * 4. Writes a timestamp file for tracking
 *
 * Syncs three directories:
 * - Config: /root/.openclaw/ (or /root/.clawdbot/) → R2:/openclaw/
 * - Workspace: /root/clawd/ → R2:/workspace/ (IDENTITY.md, MEMORY.md, memory/, assets/)
 * - Skills: /root/clawd/skills/ → R2:/skills/
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Determine which config directory exists
  // Check new path first, fall back to legacy
  // Use stdout check instead of exitCode (exitCode can be undefined in sandbox API)
  let configDir = '/root/.openclaw';
  try {
    const checkNew = await sandbox.startProcess(
      '[ -f /root/.openclaw/openclaw.json ] && echo EXISTS || echo NOTFOUND',
    );
    await waitForProcess(checkNew, 5000);
    const checkNewLogs = await checkNew.getLogs();
    const newExists = checkNewLogs.stdout?.includes('EXISTS');

    if (!newExists) {
      const checkLegacy = await sandbox.startProcess(
        '[ -f /root/.clawdbot/clawdbot.json ] && echo EXISTS || echo NOTFOUND',
      );
      await waitForProcess(checkLegacy, 5000);
      const checkLegacyLogs = await checkLegacy.getLogs();
      const legacyExists = checkLegacyLogs.stdout?.includes('EXISTS');

      if (legacyExists) {
        configDir = '/root/.clawdbot';
      } else {
        return {
          success: false,
          error: 'Sync aborted: no config file found',
          details: `Neither openclaw.json nor clawdbot.json found. New check: ${checkNewLogs.stdout || '(empty)'}, Legacy check: ${checkLegacyLogs.stdout || '(empty)'}`,
        };
      }
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to verify source files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Also sync workspace directory (excluding skills since they're synced separately)
  // Exclude large/generated directories to speed up sync: data/, logs/, __pycache__/, .coverage
  const syncCmd = `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' ${configDir}/ ${R2_MOUNT_PATH}/openclaw/ && rsync -r --no-times --delete --exclude='skills' --exclude='data' --exclude='logs' --exclude='__pycache__' --exclude='.coverage' --exclude='*.pyc' --exclude='jiti' --exclude='.git' --exclude='node-compile-cache' /root/clawd/ ${R2_MOUNT_PATH}/workspace/ && rsync -r --no-times --delete /root/clawd/skills/ ${R2_MOUNT_PATH}/skills/ && date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;
  try {
    const proc = await sandbox.startProcess(syncCmd);
    await waitForProcess(proc, 120000); // 120 second timeout for sync (s3fs is slow)

    // Check for success by reading the timestamp file
    const timestampProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync`);
    await waitForProcess(timestampProc, 5000);
    const timestampLogs = await timestampProc.getLogs();
    const lastSync = timestampLogs.stdout?.trim();

    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      return { success: true, lastSync };
    } else {
      const logs = await proc.getLogs();
      return {
        success: false,
        error: 'Sync failed',
        details: logs.stderr || logs.stdout || 'No timestamp file created',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
