import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { config } from './config';
import { initDatabase } from './database/schema';
import { StorageService } from './services/storage.service';
import { WatchfolderService } from './services/watchfolder.service';

import authRoutes from './routes/auth.routes';
import documentRoutes from './routes/document.routes';
import tagRoutes from './routes/tag.routes';
import workflowRoutes from './routes/workflow.routes';
import auditRoutes from './routes/audit.routes';

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/audit-logs', auditRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function main() {
  try {
    StorageService.initStorageDirectories();
    await initDatabase();
    WatchfolderService.startWatching();

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
