import fs from 'fs';
import path from 'path';
import { BotState } from '../types';
import { logger } from '../utils/logger';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   State Store — JSON file persistence
   ─────────────────────────────────────────────────────
   Saves bot state to disk atomically (write tmp + rename)
   so a crash mid-write doesn't corrupt the file.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export class StateStore {
  private filePath: string;
  private backupPath: string;
  private saveCount = 0;

  constructor(private dir: string, filename = 'bot_state.json') {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, filename);
    this.backupPath = path.join(dir, `${filename}.backup`);
  }

  /** Save state atomically */
  save(state: BotState): void {
    try {
      state.savedAt = new Date().toISOString();
      const json = JSON.stringify(state, null, 2);

      /* Write to temp file first */
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');

      /* Backup current file */
      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, this.backupPath);
      }

      /* Atomic rename */
      fs.renameSync(tmpPath, this.filePath);

      this.saveCount++;
      if (this.saveCount % 10 === 0) {
        logger.debug(
          { saves: this.saveCount, file: this.filePath },
          'State persisted',
        );
      }
    } catch (err: any) {
      logger.error(err, 'Failed to save state');
    }
  }

  /** Load state from disk, returns null if no state found */
  load(): BotState | null {
    /* Try main file first */
    const state = this.tryLoad(this.filePath);
    if (state) return state;

    /* Fall back to backup */
    const backup = this.tryLoad(this.backupPath);
    if (backup) {
      logger.warn('Loaded state from backup file');
      return backup;
    }

    return null;
  }

  /** Check if a saved state exists */
  exists(): boolean {
    return fs.existsSync(this.filePath) || fs.existsSync(this.backupPath);
  }

  /** Delete saved state */
  clear(): void {
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
      if (fs.existsSync(this.backupPath)) fs.unlinkSync(this.backupPath);
      logger.info('Saved state cleared');
    } catch (err: any) {
      logger.error(err, 'Failed to clear state');
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  private tryLoad(filePath: string): BotState | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const state = JSON.parse(raw) as BotState;

      /* Basic validation */
      if (!state.version || !state.strategy || !state.executor) {
        logger.warn({ file: filePath }, 'Invalid state file — skipping');
        return null;
      }

      logger.info(
        { file: filePath, savedAt: state.savedAt },
        'State loaded from disk',
      );
      return state;
    } catch (err: any) {
      logger.warn({ file: filePath, error: err.message }, 'Could not parse state file');
      return null;
    }
  }
}