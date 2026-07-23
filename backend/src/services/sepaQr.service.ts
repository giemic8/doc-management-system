export interface SepaEpcParams {
  receiverName: string;
  iban: string;
  bic?: string;
  amount: number;
  currency?: string;
  reference?: string;
}

const MAX_RECEIVER_NAME_LENGTH = 70;
const MAX_REFERENCE_LENGTH = 140;

/**
 * Builds an EPC069-12 ("SEPA EPC QR Code") payload string: the standard
 * European Payments Council format that banking apps scan to prefill a
 * SEPA credit transfer. Fixed 12-line structure; empty lines are kept
 * (not omitted) so field positions stay correct for scanners.
 */
export function buildSepaEpcPayload(params: SepaEpcParams): string {
  const { receiverName, iban, bic, amount, currency = 'EUR', reference } = params;

  if (!receiverName || receiverName.length > MAX_RECEIVER_NAME_LENGTH) {
    throw new Error(`receiverName is required and must be at most ${MAX_RECEIVER_NAME_LENGTH} characters`);
  }
  if (!iban) {
    throw new Error('iban is required');
  }
  if (!amount || amount <= 0) {
    throw new Error('amount must be a positive number');
  }

  const truncatedReference = reference ? reference.slice(0, MAX_REFERENCE_LENGTH) : '';

  const lines = [
    'BCD', // Service Tag
    '002', // Version
    '1', // Character set (1 = UTF-8)
    'SCT', // Identification (SEPA Credit Transfer)
    bic || '', // BIC (optional per EPC069-12 since 2016)
    receiverName,
    iban,
    `${currency}${amount.toFixed(2)}`,
    '', // Purpose (optional, left blank)
    truncatedReference, // Remittance information (structured or unstructured)
    '', // Remittance information (unstructured, unused here)
    '', // Beneficiary-to-originator information (unused)
  ];

  return lines.join('\n');
}
