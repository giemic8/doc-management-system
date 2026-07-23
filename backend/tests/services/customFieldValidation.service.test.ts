import { describe, it, expect } from 'vitest';
import { validateCustomFieldValues } from '../../src/services/customFieldValidation.service';

describe('validateCustomFieldValues', () => {
  const schema = [
    { id: 'f1', name: 'IBAN', field_type: 'string', required: true },
    { id: 'f2', name: 'Tax Amount', field_type: 'number', required: true },
    { id: 'f3', name: 'Renewal Date', field_type: 'date', required: false },
    { id: 'f4', name: 'Active', field_type: 'boolean', required: false },
    { id: 'f5', name: 'Category', field_type: 'dropdown', required: false, options: ['A', 'B', 'C'] },
  ];

  it('passes when all required fields are present with correct types', () => {
    const result = validateCustomFieldValues(schema, {
      f1: 'DE89370400440532013000',
      f2: 199.99,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when a required field is missing', () => {
    const result = validateCustomFieldValues(schema, { f1: 'DE89370400440532013000' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ fieldId: 'f2' }));
  });

  it('fails when a number field receives a non-numeric value', () => {
    const result = validateCustomFieldValues(schema, { f1: 'x', f2: 'not-a-number' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ fieldId: 'f2' }));
  });

  it('fails when a date field receives an invalid date string', () => {
    const result = validateCustomFieldValues(schema, { f1: 'x', f2: 1, f3: 'not-a-date' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ fieldId: 'f3' }));
  });

  it('accepts a valid ISO date for a date field', () => {
    const result = validateCustomFieldValues(schema, { f1: 'x', f2: 1, f3: '2025-01-01' });
    expect(result.valid).toBe(true);
  });

  it('fails when a boolean field receives a non-boolean value', () => {
    const result = validateCustomFieldValues(schema, { f1: 'x', f2: 1, f4: 'yes' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ fieldId: 'f4' }));
  });

  it('fails when a dropdown field receives a value outside its options', () => {
    const result = validateCustomFieldValues(schema, { f1: 'x', f2: 1, f5: 'Z' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ fieldId: 'f5' }));
  });

  it('accepts a dropdown value within its options', () => {
    const result = validateCustomFieldValues(schema, { f1: 'x', f2: 1, f5: 'B' });
    expect(result.valid).toBe(true);
  });

  it('does not require optional fields to be present', () => {
    const result = validateCustomFieldValues(schema, { f1: 'x', f2: 1 });
    expect(result.valid).toBe(true);
  });
});
