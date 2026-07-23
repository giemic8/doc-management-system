import { PDFDocument } from 'pdf-lib';

/**
 * Splits a PDF into two independent PDFs at `splitAtPage` (1-indexed): the
 * first document gets pages [1, splitAtPage], the second gets the rest.
 */
export async function splitPdfPages(source: Buffer, splitAtPage: number): Promise<[Buffer, Buffer]> {
  const original = await PDFDocument.load(source);
  const totalPages = original.getPageCount();

  if (splitAtPage < 1 || splitAtPage >= totalPages) {
    throw new Error(`splitAtPage must be between 1 and ${totalPages - 1} (inclusive) for a ${totalPages}-page document`);
  }

  const firstDoc = await PDFDocument.create();
  const secondDoc = await PDFDocument.create();

  const firstIndices = Array.from({ length: splitAtPage }, (_, i) => i);
  const secondIndices = Array.from({ length: totalPages - splitAtPage }, (_, i) => i + splitAtPage);

  const firstPages = await firstDoc.copyPages(original, firstIndices);
  firstPages.forEach((p) => firstDoc.addPage(p));

  const secondPages = await secondDoc.copyPages(original, secondIndices);
  secondPages.forEach((p) => secondDoc.addPage(p));

  const firstBytes = await firstDoc.save();
  const secondBytes = await secondDoc.save();

  return [Buffer.from(firstBytes), Buffer.from(secondBytes)];
}

/** Merges two or more PDFs into a single PDF, preserving input order. */
export async function mergePdfs(sources: Buffer[]): Promise<Buffer> {
  if (sources.length < 2) {
    throw new Error('mergePdfs requires at least two PDFs to merge');
  }

  const mergedDoc = await PDFDocument.create();

  for (const source of sources) {
    const doc = await PDFDocument.load(source);
    const pages = await mergedDoc.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => mergedDoc.addPage(p));
  }

  const bytes = await mergedDoc.save();
  return Buffer.from(bytes);
}
