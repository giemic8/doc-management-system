import { config } from './config';
import { initDatabase } from './database/schema';
import { StorageService } from './services/storage.service';
import { WatchfolderService } from './services/watchfolder.service';
import { startEmailImportScheduler } from './services/emailImportScheduler.service';
import { startContractAlertScheduler } from './services/contractAlertScheduler.service';
import { startSimilarityScanScheduler } from './services/similarityScanScheduler.service';
import { startOpsAlertScheduler } from './services/opsAlertScheduler.service';
import { app } from './app';

async function main() {
  try {
    StorageService.initStorageDirectories();
    await initDatabase();
    WatchfolderService.startWatching();
    startEmailImportScheduler();
    startContractAlertScheduler();
    startSimilarityScanScheduler();
    startOpsAlertScheduler();

    app.listen(config.port, () => {
      console.log(`=======================================================`);
      console.log(`🚀 DMS API Gateway running on http://localhost:${config.port}`);
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
}

main();
