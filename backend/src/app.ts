import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import authRoutes from './routes/auth.routes';
import documentRoutes from './routes/document.routes';
import { trashRouter } from './routes/trash.routes';
import tagRoutes from './routes/tag.routes';
import workflowRoutes from './routes/workflow.routes';
import auditRoutes from './routes/audit.routes';
import adminRoutes from './routes/admin.routes';
import webhookRoutes from './routes/webhook.routes';
import searchRoutes from './routes/search.routes';
import customFieldRoutes from './routes/customField.routes';
import emailImportRoutes from './routes/emailImport.routes';
import { documentRetentionRouter, auditExportRouter } from './routes/retention.routes';
import chatRoutes from './routes/chat.routes';
import { datevExportRouter } from './routes/datevExport.routes';
import calendarRoutes from './routes/calendar.routes';
import analyticsRoutes from './routes/analytics.routes';
import contractsRoutes from './routes/contracts.routes';
import { shareLinkRouter, publicShareRouter } from './routes/shareLink.routes';
import backupRoutes from './routes/backup.routes';
import accessGroupRoutes from './routes/accessGroup.routes';

export const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
// Ticket #33 -- registered before documentRoutes so GET /api/documents/trash
// is not matched by GET /api/documents/:id.
app.use('/api/documents', trashRouter);
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
app.use('/api/chat', chatRoutes);
app.use('/api/export', datevExportRouter);
app.use('/api/calendar', calendarRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/contracts', contractsRoutes);
app.use('/api/documents', shareLinkRouter);
app.use('/api/share', publicShareRouter);
app.use('/api/backup', backupRoutes);
app.use('/api/access-groups', accessGroupRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
