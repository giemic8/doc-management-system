import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { StorageService } from './storage.service';
import { query } from '../database/db';
import { addDocumentProcessingJob } from './queue.service';

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
        const fileHash = await StorageService.calculateFileHash(filePath);
        const stats = fs.statSync(filePath);
        const destPath = StorageService.getOriginalFilePath(`${Date.now()}_${filename}`);

        // Move file from input to storage/originals
        fs.renameSync(filePath, destPath);

        // Save initial record in DB
        const dbResult = await query(
          `INSERT INTO documents (title, original_filename, file_path, file_size, mime_type, file_hash, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'processing')
           RETURNING id;`,
          [filename, filename, destPath, stats.size, 'application/pdf', fileHash]
        );

        const docId = dbResult.rows[0].id;
        console.log(`Document saved with ID ${docId}, triggering processing job...`);

        // Queue processing
        await addDocumentProcessingJob(docId, destPath);
      } catch (err) {
        console.error(`Error processing watchfolder file ${filePath}:`, err);
      }
    });
  }
}
