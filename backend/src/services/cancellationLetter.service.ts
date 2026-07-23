import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface CancellationLetterDetails {
  vendorName: string;
  vendorAddress?: string;
  customerNumber?: string;
  contractTitle: string;
  cancellationDeadline?: string;
  senderName?: string;
}

/**
 * Generates a simple, formal German business cancellation letter as a
 * single-page A4 PDF. Sender info, recipient (vendor) address block, the
 * current date, a subject line, a body paragraph referencing the customer
 * number and the requested cancellation deadline, and a closing/signature
 * line.
 */
export async function buildCancellationLetterPdf(details: CancellationLetterDetails): Promise<Buffer> {
  const {
    vendorName,
    vendorAddress,
    customerNumber,
    contractTitle,
    cancellationDeadline,
    senderName,
  } = details;

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  // A4 in points
  const page = doc.addPage([595.28, 841.89]);
  const margin = 56.7; // ~2cm
  let y = page.getHeight() - margin;
  const black = rgb(0.1, 0.1, 0.12);

  const drawLine = (text: string, opts?: { font?: typeof font; size?: number; gap?: number }) => {
    const usedFont = opts?.font ?? font;
    const size = opts?.size ?? 11;
    page.drawText(text, { x: margin, y, size, font: usedFont, color: black });
    y -= opts?.gap ?? size + 6;
  };

  const today = new Date();
  const formattedDate = today.toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' });

  // Sender block (top)
  if (senderName) {
    drawLine(senderName, { size: 10 });
  }
  y -= 10;

  // Recipient address block
  drawLine(vendorName, { font: boldFont, size: 11 });
  if (vendorAddress) {
    for (const line of vendorAddress.split('\n')) {
      drawLine(line, { size: 10 });
    }
  }

  y -= 24;

  // Date, right-aligned-ish (simple left placement is sufficient per spec)
  drawLine(`Datum: ${formattedDate}`, { size: 10 });

  y -= 14;

  // Subject line
  drawLine(`Betreff: Kündigung des Vertrags "${contractTitle}"`, { font: boldFont, size: 12 });

  y -= 10;

  drawLine('Sehr geehrte Damen und Herren,', { size: 11 });
  y -= 4;

  const customerNumberText = customerNumber
    ? `unter der Kundennummer ${customerNumber} `
    : '';
  const deadlineText = cancellationDeadline
    ? `zum ${new Date(cancellationDeadline).toLocaleDateString('de-DE')} `
    : 'zum nächstmöglichen Termin ';

  const bodyLines = wrapText(
    `hiermit kündige ich den oben genannten Vertrag ${customerNumberText}fristgerecht ${deadlineText}. ` +
      `Ich bitte Sie, mir die Kündigung sowie das Vertragsende schriftlich zu bestätigen.`,
    font,
    11,
    page.getWidth() - margin * 2
  );
  for (const line of bodyLines) {
    drawLine(line, { size: 11 });
  }

  y -= 10;
  drawLine('Für Rückfragen stehe ich Ihnen gerne zur Verfügung.', { size: 11 });

  y -= 20;
  drawLine('Mit freundlichen Grüßen', { size: 11 });
  y -= 30;
  drawLine(senderName ?? '_________________________', { size: 11 });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/** Very small greedy word-wrap helper sized against a pdf-lib font. */
function wrapText(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(candidate, size);
    if (width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
