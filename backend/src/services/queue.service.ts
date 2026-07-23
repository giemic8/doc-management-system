import { Queue } from 'bullmq';
import { config } from '../config';

let documentQueue: Queue | null = null;

try {
  documentQueue = new Queue('document-processing', {
    connection: {
      host: config.redisHost,
      port: config.redisPort,
    },
  });
  console.log('BullMQ Queue connected to Redis');
} catch (err) {
  console.warn('Redis queue connection deferred / error:', err);
}

export async function addDocumentProcessingJob(documentId: string, filePath: string) {
  if (documentQueue) {
    await documentQueue.add('process-document', {
      documentId,
      filePath,
      timestamp: Date.now(),
    });
    console.log(`Enqueued document ${documentId} for OCR & AI processing.`);
  } else {
    console.log(`Mock enqueued document ${documentId} (Redis disabled).`);
  }
}
