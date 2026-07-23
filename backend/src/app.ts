import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import authRoutes from './routes/auth.routes';
import documentRoutes from './routes/document.routes';
import tagRoutes from './routes/tag.routes';
import workflowRoutes from './routes/workflow.routes';
import auditRoutes from './routes/audit.routes';
import adminRoutes from './routes/admin.routes';
import webhookRoutes from './routes/webhook.routes';
import searchRoutes from './routes/search.routes';
import customFieldRoutes from './routes/customField.routes';
import emailImportRoutes from './routes/emailImport.routes';
import { documentRetentionRouter, auditExportRouter } from './routes/retention.routes';

export const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/custom-fields', customFieldRoutes);
app.use('/api/email-import', emailImportRoutes);
app.use('/api/documents', documentRetentionRouter);
app.use('/api/export', auditExportRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
