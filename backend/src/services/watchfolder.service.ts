import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { ingestDocument } from './ingestion.service';
import { StorageService } from './storage.service';

export class WatchfolderService {
  private static watcher: chokidar.FSWatcher | null = null;

  public static startWatching() {
    const inputPath = path.join(config.storagePath, 'input');
    if (!fs.existsSync(inputPath)) {
      fs.mkdirSync(inputPath, { recursive: true });
    }

    console.log(`Starting Watchfolder listener on: ${inputPath}`);
    this.watcher = chokidar.watch(inputPath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500,
      },
    });

    this.watcher.on('add', async (filePath) => {
      const filename = path.basename(filePath);
      if (filename === '.gitkeep') return;

      console.log(`Watchfolder detected new scan file: ${filename}`);
      try {
        const identity = `${filename}:${await StorageService.calculateFileHash(filePath)}`;
        const { document, replayed } = await ingestDocument({
          stagedPath: filePath,
          source: 'watchfolder',
          idempotencyKey: identity,
          filename,
          mimeType: 'application/pdf',
        });
        console.log(`Watchfolder document ${document.id} ${replayed ? 'already ingested' : 'ready for processing'}`);
      } catch (err) {
        console.error(`Error processing watchfolder file ${filePath}:`, err);
      }
    });
  }
}
