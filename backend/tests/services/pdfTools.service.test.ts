import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { splitPdfPages, mergePdfs } from '../../src/services/pdfTools.service';

async function makeTestPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`Page ${i + 1}`, { x: 10, y: 100 });
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

describe('pdfTools.service', () => {
  describe('splitPdfPages', () => {
    it('splits a multi-page PDF into two independent PDFs at the given boundary', async () => {
      const original = await makeTestPdf(4);
      const [firstPart, secondPart] = await splitPdfPages(original, 2);

      const firstDoc = await PDFDocument.load(firstPart);
      const secondDoc = await PDFDocument.load(secondPart);

      expect(firstDoc.getPageCount()).toBe(2);
      expect(secondDoc.getPageCount()).toBe(2);
    });

    it('supports splitting at page 1 (first page becomes its own document)', async () => {
      const original = await makeTestPdf(5);
      const [firstPart, secondPart] = await splitPdfPages(original, 1);

      const firstDoc = await PDFDocument.load(firstPart);
      const secondDoc = await PDFDocument.load(secondPart);

      expect(firstDoc.getPageCount()).toBe(1);
      expect(secondDoc.getPageCount()).toBe(4);
    });

    it('rejects an out-of-range split point', async () => {
      const original = await makeTestPdf(3);
      await expect(splitPdfPages(original, 0)).rejects.toThrow();
      await expect(splitPdfPages(original, 3)).rejects.toThrow();
    });
  });

  describe('mergePdfs', () => {
    it('merges multiple PDFs into one, preserving page order', async () => {
      const pdfA = await makeTestPdf(2);
      const pdfB = await makeTestPdf(3);

      const merged = await mergePdfs([pdfA, pdfB]);
      const mergedDoc = await PDFDocument.load(merged);

      expect(mergedDoc.getPageCount()).toBe(5);
    });

    it('rejects merging fewer than two PDFs', async () => {
      const pdfA = await makeTestPdf(2);
      await expect(mergePdfs([pdfA])).rejects.toThrow();
    });
  });
});
